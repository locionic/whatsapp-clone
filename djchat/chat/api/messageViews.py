from rest_framework import viewsets, status
from rest_framework.response import Response
from rest_framework.exceptions import ParseError, PermissionDenied
from rest_framework.views import APIView

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from django.shortcuts import get_object_or_404
from django.contrib.auth import get_user_model

from .serializers import MessageSerializer, CreateMessageSerializer, \
    RoomSerializer, UnreadMessageSerializer

from users.api.serializers import UserSerializer
from chat.models import Message, Room

channel_layer = get_channel_layer()
User = get_user_model()


class UnreadMessagesAPIView(APIView):
    """
    Endpoints related unread messages
    """
    # No `queryset`: this view reads request.user.unread_messages, and DRF
    # derives an operationId's base name from queryset.model -- which made
    # /messages/unread claim 'createMessage' and 'listMessages', already taken
    # by the MessageViewSet routes.
    serializer_class = UnreadMessageSerializer

    def get(self, request, format=None):
        """
        List unread messages for a specific user
        """
        unread_messages_serializer = UnreadMessageSerializer(
            request.user.unread_messages.all(),
            context={'request': request},
            many=True)
        return Response({
            'messages': unread_messages_serializer.data
        })

    def post(self, request, format=None):
        """
        Mark an specific message as read
        """
        try:
            message_id = request.query_params.get('message_id')
            message_obj = request.user.unread_messages.get(id=message_id)
            message_obj.mark_as_read(request.user)
        except (Message.DoesNotExist, ValueError, TypeError):
            # The message is not unread for this user, or message_id is
            # absent/malformed. The endpoint is idempotent by contract, so
            # still answer 204 -- but let real failures (DB down, etc.) raise.
            pass
        return Response(None, status=status.HTTP_204_NO_CONTENT)


class LastMessagesRoomAPIView(APIView):
    """
    Endpoints related to managing rooms with recent activity
    """
    queryset = Message.objects.all()

    def get(self, request, room_id, format=None):
        """
        List rooms with recent conversations
        """
        # get room
        room = get_object_or_404(request.user.rooms.all(), id=room_id)
        room_serializer = RoomSerializer(
            room,
            context={'request': request})
        # get messages
        offset = self.request.query_params.get('offset')
        try:
            offset = int(offset) if offset else None
        except ValueError:
            # int() on a raw query param: '?offset=abc' escaped as a 500 for
            # anyone who could reach the room, on a read-only endpoint.
            raise ParseError(detail='offset must be a message id.')
        # `?search=` narrows the queryset and `?offset=` pages through it, so the
        # two compose with nothing extra: filter first, then let the branch below
        # decide which end of the result it is showing. An empty `?search=` is
        # falsy, so it is the no-search path rather than "match the empty string".
        #
        # Server-side because the client cannot do it: a room opens with the
        # newest ten (the `[:10]` below), so anything filtering
        # `state.roomMessages` on the client would answer "no such message" for
        # every message it never fetched. `icontains` and not `contains`:
        # LIKE is case-sensitive on Postgres, and a search box is not
        # case-sensitive to the person using it.
        search = self.request.query_params.get('search')
        messages_qs = room.messages
        if search:
            messages_qs = messages_qs.filter(body__icontains=search)
        if offset:
            messages = messages_qs   \
                .filter(id__lt=offset) \
                .order_by('-id')[:10][::-1]
        else:
            messages = messages_qs.order_by(
                '-timestamp')[:10][::-1]
        messages_serializer = MessageSerializer(
            messages,
            context={'request': request},
            many=True)
        # get participants
        participants = set()
        for message in messages_serializer.data:
            participants.add(message['author'])
        participants_obj = User.objects.filter(id__in=participants)
        users_serializer = UserSerializer(participants_obj, many=True)
        # combine response
        return Response({
            'messages': messages_serializer.data,
            'room': room_serializer.data,
            'users': users_serializer.data,
        })


class MessageViewSet(viewsets.ViewSet):
    """
    Endpoints related to managing messages
    """
    queryset = Message.objects.all()
    serializer_class = CreateMessageSerializer

    def list(self, request):
        """
        List user's pending to receive messages
        """
        pending_messages_qs = Message.objects\
            .get_pending_messages(request.user)
        messages_serializer = MessageSerializer(pending_messages_qs,
                                                context={'request': request},
                                                many=True)
        # get relations of the rooms
        rooms = set()
        for message_data in messages_serializer.data:
            rooms.add(message_data['room'])
        rooms_obj = Room.objects.filter(id__in=rooms)
        rooms_serializer = RoomSerializer(rooms_obj,
                                          context={'request': request},
                                          many=True)
        # get relations of the users
        users = set()
        for room_data in rooms_serializer.data:
            users = users.union(set(room_data['participants']))
        users_obj = User.objects.filter(id__in=users)
        users_serializer = UserSerializer(users_obj, many=True)
        # combine response
        return Response({
            'messages': messages_serializer.data,
            'rooms': rooms_serializer.data,
            'users': users_serializer.data,
        })

    def create(self, request):
        """
        Create new message in backend and signal participants to receive it
        """
        user = request.user
        # Validation
        serializer = CreateMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        room = serializer.validated_data.get('room')
        if not user in room.participants.all():
            raise PermissionDenied(
                detail='Current user is not authorized to publish in the room')
        # Message creation
        message = serializer.save(author=user)
        # .set() rather than save(pending_reception=...): M2M assignment rejects
        # lists outright and only tolerates QuerySets by luck.
        message.pending_reception.set(room.participants.all())
        message.pending_read.set(room.participants.exclude(id=user.id))
        # Update activity timestamp of rooms
        room.save()
        # Push to participants
        for participant in room.participants.all():
            async_to_sync(channel_layer.group_send)(
                f"group_general_user_{participant.id}", {
                    "type": "chat_message",
                    "message": "update",
                    'data': {}
                })
        return Response(serializer.data, status=status.HTTP_201_CREATED)
