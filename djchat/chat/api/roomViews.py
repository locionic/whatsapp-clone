from rest_framework import viewsets, status
from rest_framework.response import Response
from rest_framework.exceptions import ParseError
from rest_framework.views import APIView

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404

from users.api.serializers import UserSerializer
from .serializers import RoomSerializer, MessageSerializer
from chat.models import Room, Message
from friends.api.views import FriendshipRemoveAPIView

channel_layer = get_channel_layer()
User = get_user_model()


class RoomDeleteAPIView(APIView):
    """
    Delete the room
    """

    def post(self, request, room_id, format=None):
        # Get room
        room = get_object_or_404(
            request.user.rooms.all(),
            id=room_id)
        # Signal deletion to participants
        room.signal_to_room(
            'room_delete',
            data={'room_id': room.id})
        # Delete friendship if private
        if (room.kind == 1):
            user_1 = room.participants.all()[0]
            user_2 = room.participants.all()[1]
            user_id = user_2.id if user_1 == request.user else user_1.id
            FriendshipRemoveAPIView.post(self, request, user_id)
        # Delete room
        room.delete()
        return Response(None, status=status.HTTP_204_NO_CONTENT)


class RoomMarkAsReadAPIView(APIView):
    """
    Mark all room messages as read
    """

    def post(self, request, room_id, format=None):
        # Get room
        room = get_object_or_404(
            request.user.rooms.all(),
            id=room_id)
        # Mark messages as read
        Message.objects.mark_room_as_read(request.user, room)
        return Response(None, status=status.HTTP_204_NO_CONTENT)


class RoomWritingAPIView(APIView):
    """
    Signal to users in a room who is writing
    """

    def post(self, request, room_id, format=None):
        # Get room
        room = get_object_or_404(
            request.user.rooms.all(),
            id=room_id)
        # Push writing signal to participants
        for participant in room.participants.exclude(id=request.user.id):
            async_to_sync(channel_layer.group_send)(
                f"group_general_user_{participant.id}", {
                    "type": "chat_message",
                    "message": "writing",
                    'data': {
                        'user_id': request.user.id,
                        'room_id': room.id
                    }
                })
        return Response(None, status=status.HTTP_204_NO_CONTENT)


class RecentRoomsAPIView(APIView):
    """
    Endpoints related to managing rooms with recent activity
    """
    queryset = Room.objects.all()

    def get(self, request, format=None):
        """
        List rooms with recent conversations
        """
        # get recent rooms
        qs_rooms = request.user.rooms.all().order_by('-last_activity')[:10]
        room_serializer = RoomSerializer(
            qs_rooms,
            context={'request': request},
            many=True)
        # get relations of the rooms
        participants = set()
        messages = set()
        for room_data in room_serializer.data:
            participants = participants.union(set(room_data['participants']))
            messages.add(room_data['last_message'])
        # build relation responses
        participants_obj = User.objects.filter(id__in=participants)
        users_serializer = UserSerializer(participants_obj, many=True)
        messages_obj = Message.objects.filter(id__in=messages)
        messages_serializer = MessageSerializer(messages_obj,
                                                context={'request': request},
                                                many=True)
        # combine response
        return Response({
            'rooms': room_serializer.data,
            'messages': messages_serializer.data,
            'users': users_serializer.data
        })


class RoomViewSet(viewsets.ViewSet):
    """
    Endpoints related to managing rooms
    """
    queryset = Room.objects.all()
    serializer_class = RoomSerializer

    def list(self, request):
        """
        List rooms in which the current user is a participant
        """
        # get all rooms
        qs_rooms = request.user.rooms.all()
        print('done_room_1')
        room_serializer = RoomSerializer(
            qs_rooms,
            context={'request': request},
            many=True)
        print('done_room_2')
        # get relations of the rooms
        participants = set()
        print('done_room_3')
        messages = set()
        print('done_room_4')
        for room_data in room_serializer.data:
            participants = participants.union(set(room_data['participants']))
            messages.add(room_data['last_message'])
        print('done_room_5')
        # build participants response
        participants_obj = User.objects.filter(id__in=participants)
        print('done_room_6')
        users_serializer = UserSerializer(participants_obj, many=True)
        print('done_room_8')
        # build messages response
        messages_obj = Message.objects.filter(id__in=messages)
        print('done_room_9')
        messages_serializer = MessageSerializer(messages_obj,
                                                context={'request': request},
                                                many=True)
        print('done_room_10')
        print({
            'rooms': room_serializer.data,
            'messages': messages_serializer.data,
            'users': users_serializer.data
        })
        # combine response
        try:
            return Response({
                'rooms': room_serializer.data,
                'messages': messages_serializer.data,
                'users': users_serializer.data
            })
        except Exception as e:
            print(e)
            print('tai sao khong tra ve response')

    def create(self, request):
        """
        get (private kind) or create a new room with participants
        """
        user = request.user
        # Validation of fields
        serializer = RoomSerializer(
            data=request.data,
            context={'request': request})
        serializer.is_valid(raise_exception=True)
        # Validate participant number
        participants = serializer.validated_data.get('participants')
        if not user in participants:
            participants.append(user)
        if len(participants) == 1:
            raise ParseError(
                detail='There must be at least one another participant.')
        # Validate by kind
        kind = serializer.validated_data.get('kind')
        if (kind == 1):
            # Private chats must have 2 participants
            if len(participants) != 2:
                raise ParseError(
                    detail='Private chats must have exactly 2 participants.')
            # There cant be two private chats with same participants
            room_qs = Room.objects\
                .filter(kind=kind, participants__in=[participants[0]])\
                .filter(kind=kind, participants__in=[participants[1]])\
                .first()
            # If there exists private room return it
            if room_qs:
                return Response(RoomSerializer(room_qs,
                                               context={'request': request}).data,
                                status=status.HTTP_200_OK)
            # Be sure to clear group name in private chats
            if 'group_name' in serializer.validated_data:
                serializer.validated_data['group_name'] = None
        elif (kind == 2):
            # Group chats must have a name
            if not 'group_name' in serializer.validated_data:
                raise ParseError(
                    detail='Group rooms must have a name.')
            if len(serializer.validated_data['group_name'].strip()) == 0:
                raise ParseError(
                    detail='Group rooms must have a name.')
        # Create room
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)
