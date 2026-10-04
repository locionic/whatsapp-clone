import csv
import io

from rest_framework import viewsets, status
from rest_framework.response import Response
from rest_framework.exceptions import ParseError
from rest_framework.views import APIView

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from django.contrib.auth import get_user_model
from django.db.models import Count
from django.db.models.functions import TruncDate
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from datetime import timedelta

from users.api.serializers import UserSerializer
from .serializers import RoomSerializer, CreateRoomSerializer, MessageSerializer
from chat.models import Room, Message
from friends.api.views import FriendshipRemoveAPIView

channel_layer = get_channel_layer()
User = get_user_model()

# Wide enough to show a rhythm (weekends vs weekdays), short enough that a
# year-old room is not mostly empty.
ACTIVITY_DAYS = 30


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
            # One query, not two: participants has no Meta.ordering, so
            # indexing all()[0] and all()[1] separately can yield the two
            # rows in different orders and "delete yourself as a friend".
            participants = list(room.participants.all())
            user_id = (participants[1].id if participants[0] == request.user
                       else participants[0].id)
            FriendshipRemoveAPIView.post(self, request, user_id)
        # Delete room
        room.delete()
        return Response(None, status=status.HTTP_204_NO_CONTENT)


class RoomExportAPIView(APIView):
    """
    Download a room's messages as JSON (default) or CSV
    """

    CSV_COLUMNS = ('id', 'author', 'body', 'timestamp')

    def get(self, request, room_id, format=None):
        # Same membership gate as every other room endpoint: 404, not 403, so
        # the response does not confirm that the room exists.
        room = get_object_or_404(request.user.rooms.all(), id=room_id)
        messages = room.messages.order_by('timestamp')
        # 'as', not 'format': DRF's URL_FORMAT_OVERRIDE is 'format', so
        # content negotiation eats it, finds no renderer registered for 'csv',
        # and 404s before this view is ever called.
        export_format = request.query_params.get('as', 'json')

        if export_format not in ('json', 'csv'):
            raise ParseError(detail="as must be 'json' or 'csv'.")

        if export_format == 'csv':
            return self._csv(room, messages)
        return self._json(request, room, messages)

    def _payload(self, request, room, messages):
        """The room block is assembled here rather than through RoomSerializer
        on purpose: get_last_message() calls remove_user_from_pending(), so
        serializing a room marks its last message as received and pushes
        all_received to the sender. A read-only download should not do that."""
        return {
            'room': {
                'id': room.id,
                'kind': room.kind,
                'group_name': room.group_name,
                'participants': UserSerializer(room.participants.all(), many=True).data,
            },
            'message_count': messages.count(),
            'messages': MessageSerializer(
                messages, context={'request': request}, many=True).data,
        }

    def _json(self, request, room, messages):
        response = Response(self._payload(request, room, messages))
        # Same disposition as _csv, and for the same reason: this endpoint is a
        # download, so both of its formats have to download. Without it `?as=csv`
        # saved the file and `?as=json` -- the default -- navigated the tab away
        # from the SPA and printed the payload on screen. It is also why the UI
        # needs no JavaScript at all: a bare <a href> is the whole client.
        response['Content-Disposition'] = \
            f'attachment; filename="room-{room.id}.json"'
        return response

    def _csv(self, room, messages):
        buffer = io.StringIO()
        writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL)
        writer.writerow(self.CSV_COLUMNS)
        for message in messages:
            writer.writerow([message.id, message.author_id, message.body,
                             message.timestamp.isoformat()])

        response = HttpResponse(buffer.getvalue(), content_type='text/csv')
        response['Content-Disposition'] = \
            f'attachment; filename="room-{room.id}.csv"'
        return response


class RoomActivityAPIView(APIView):
    """
    How many messages this room got per day, for a small activity chart
    """

    def get(self, request, room_id, format=None):
        room = get_object_or_404(request.user.rooms.all(), id=room_id)
        # The chart draws one bar per day and reads them by position, so the
        # series is zero-filled and in order -- a sparse list would plot the
        # wrong day without looking wrong.
        first_day = timezone.localdate() - timedelta(days=ACTIVITY_DAYS - 1)
        counts = {
            row['day']: row['n']
            for row in room.messages
            .filter(timestamp__date__gte=first_day)
            .annotate(day=TruncDate('timestamp'))
            .values('day')
            .annotate(n=Count('id'))
        }

        per_day = []
        for offset in range(ACTIVITY_DAYS):
            day = first_day + timedelta(days=offset)
            per_day.append({'date': day.isoformat(), 'count': counts.get(day, 0)})

        return Response({
            'room_id': room.id,
            'days': ACTIVITY_DAYS,
            'total': sum(counts.values()),
            'peak': max(counts.values(), default=0),
            'per_day': per_day,
        })


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
    # No `queryset`: this view reads request.user.rooms, and DRF derives an
    # operationId's base name from queryset.model -- which made /rooms/recents
    # claim 'listRooms', already taken by the RoomViewSet route.
    serializer_class = RoomSerializer

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
        # build participants response
        participants_obj = User.objects.filter(id__in=participants)
        users_serializer = UserSerializer(participants_obj, many=True)
        # build messages response
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

    def create(self, request):
        """
        get (private kind) or create a new room with participants
        """
        user = request.user
        # Validation of fields
        serializer = CreateRoomSerializer(
            data=request.data,
            context={'request': request})
        serializer.is_valid(raise_exception=True)
        # Validate participant number
        participants = serializer.validated_data.get('participants')
        if not user in participants:
            participants.append(user)
        # Distinct count, not length: the question is whether the author has
        # anyone *else* in the room, and a list that names the author twice is
        # two entries and one person. Counting let `[me, me]` through -- the
        # append above is skipped when the author is already listed -- and
        # `get_or_create_private` then added that same user twice, which is one
        # participant. A private room with one participant is not a thing the
        # rest of this file can read: RoomSerializer.get_group_name indexes
        # `participants[0]` and RoomDeleteAPIView indexes `participants[1]`, so
        # both the response here and every later /rooms/ call -- the app's
        # first two requests on load -- raise IndexError. And the delete
        # endpoint, the one way out, is one of them. Rejecting here keeps the
        # row from being written, which is what makes it unrecoverable.
        if len(set(participants)) == 1:
            raise ParseError(
                detail='There must be at least one another participant.')
        # Validate by kind
        kind = serializer.validated_data.get('kind')
        if (kind == 1):
            # Private chats must have 2 participants
            if len(participants) != 2:
                raise ParseError(
                    detail='Private chats must have exactly 2 participants.')
            # There cant be two private chats with the same participants
            # (shared with the accept signal, which used to create blindly)
            room, created = Room.get_or_create_private(*participants)
            if created:
                room.signal_to_room('update_rooms', data={})
            return Response(RoomSerializer(room, context={'request': request}).data,
                            status=status.HTTP_201_CREATED if created
                            else status.HTTP_200_OK)
        elif (kind == 2):
            # Group chats must have a name
            group_name = serializer.validated_data.get('group_name')
            if not group_name or len(group_name.strip()) == 0:
                raise ParseError(
                    detail='Group rooms must have a name.')
        # Create room
        room = serializer.save()
        # This was the one push site that pushed nothing, and a group is the
        # only room anyone can appear in without acting first -- so the people
        # added to it saw no room until they reloaded by hand. 'update_rooms'
        # is what App.vue already answers with fetchRooms.
        room.signal_to_room('update_rooms', data={})
        return Response(RoomSerializer(room, context={'request': request}).data,
                        status=status.HTTP_201_CREATED)
