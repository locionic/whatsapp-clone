from friends.signals import (friendship_request_created,
                             friendship_request_canceled,
                             friendship_request_accepted,
                             friendship_request_rejected
                             )
from django.dispatch import receiver

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .models import Room

channel_layer = get_channel_layer()


@receiver(friendship_request_created)
def friendship_request_created_callback(sender, **kwargs):
    async_to_sync(channel_layer.group_send)(
        f"group_general_user_{sender.to_user.id}", {
            "type": "chat_message",
            "message": 'update_received',
            'data': {}
        })


@receiver(friendship_request_canceled)
def friendship_request_canceled_callback(sender, to_user, **kwargs):
    async_to_sync(channel_layer.group_send)(
        f"group_general_user_{to_user.id}", {
            "type": "chat_message",
            "message": 'update_received',
            'data': {}
        })


@receiver(friendship_request_accepted)
def friendship_request_accepted_callback(sender, to_user, from_user, **kwargs):
    room, created = Room.get_or_create_private(to_user, from_user)
    room.signal_to_room('update_rooms', data={})
    # Both of them, not just the inviter. `accept()` deletes the reverse
    # request as well as the accepted one, so an accepter who had invited back
    # is left holding a Sent row for a request that no longer exists -- with a
    # Cancel button on it that 404s, since accept() is what deleted it. Their
    # own HTTP response only carries the *received* list, so this push is the
    # one thing that can clear it. Same reason the reject callback below pushes
    # to the sender, and it keeps the cross-invite row from outliving the tab
    # that shows it.
    for user in (from_user, to_user):
        async_to_sync(channel_layer.group_send)(
            f"group_general_user_{user.id}", {
                "type": "chat_message",
                "message": 'update_sent',
                'data': {}
            })


@receiver(friendship_request_rejected)
def friendship_request_rejected_callback(sender, **kwargs):
    """reject() sends this signal and busts the sender's sent_requests cache,
    but nothing pushed it to the sender's socket -- the one friendship event
    with no receiver. Their client kept showing the invitation as pending
    until a manual reload, and busting the cache only helps whoever asks
    again. 'update_sent' is what App.vue dispatches fetchSentInvitations on.
    """
    async_to_sync(channel_layer.group_send)(
        f"group_general_user_{sender.from_user.id}", {
            "type": "chat_message",
            "message": 'update_sent',
            'data': {}
        })
