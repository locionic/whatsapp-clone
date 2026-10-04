from rest_framework import serializers
from django.contrib.auth import get_user_model

from users.api.serializers import UserSerializer
from chat.models import Message, Room

User = get_user_model()


class UnreadMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Message
        fields = ('id', 'room',)


class MessageSerializer(serializers.ModelSerializer):
    is_owner = serializers.SerializerMethodField()
    all_received = serializers.SerializerMethodField()
    all_read = serializers.SerializerMethodField()

    class Meta:
        model = Message
        exclude = ('pending_reception', 'pending_read',)

    def get_is_owner(self, obj):
        # True is the request user is the owner
        user = self.context['request'].user
        return True if obj.author.id == user.id else False

    def get_all_received(self, obj):
        # True is all participants have received it
        return False if obj.pending_reception.exists() else True

    def get_all_read(self, obj):
        # True if all participants have read it
        return False if obj.pending_read.exists() else True


class CreateMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Message
        fields = ('room', 'body', 'front_key',)


class RoomSerializer(serializers.ModelSerializer):
    last_message = serializers.SerializerMethodField()
    group_name = serializers.SerializerMethodField()
    group_profile = serializers.SerializerMethodField()

    class Meta:
        model = Room
        fields = '__all__'

    def get_last_message(self, obj):
        current_user = self.context['request'].user
        last_message = obj.messages.all().order_by('-timestamp').first()
        if last_message:
            last_message.remove_user_from_pending(current_user)
        return last_message.id if last_message else None

    def get_group_name(self, obj):
        if obj.kind == 1:
            # If private then return name of the other participant
            current_user = self.context['request'].user
            participants = list(obj.participants.all())
            participants.remove(current_user)
            return participants[0].username
        return obj.group_name

    def get_group_profile(self, obj):
        if obj.kind == 1:
            # If private then return name of the other participant
            current_user = self.context['request'].user
            participants = list(obj.participants.all())
            participants.remove(current_user)
            return UserSerializer(participants[0]).data
        # A group has no single profile, but the client reads username off
        # this field for its avatar and heading -- returning the bare name
        # string left it truthy but .username-less, so group profiles
        # rendered blank.
        return {'id': None, 'username': obj.group_name, 'tagline': ''}


class CreateRoomSerializer(serializers.ModelSerializer):
    """ Writable side of the room API.

    RoomSerializer shadows `group_name` with a SerializerMethodField (private
    rooms report the peer's username), which makes it read-only and silently
    drops the name on create. Validate writes here instead.
    """

    class Meta:
        model = Room
        fields = ('kind', 'participants', 'group_name')
