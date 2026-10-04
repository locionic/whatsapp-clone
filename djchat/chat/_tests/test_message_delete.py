"""Deleting a message you sent. A gap, not a regression.

`ContactProfile.vue:126` offers "Delete chat" and the room endpoint behind it
works, so the app can throw away a whole conversation. There is no way to remove
one message from one: `MessageViewSet` is a bare `viewsets.ViewSet` with only
`list` and `create`, `chat/api/urls.py` has no message-level `delete` route, and
nothing in `frontend/src` dispatches one. So a message you sent by mistake, or
one that should not have been said, was permanent for both sides -- which is the
one thing a chat app is not allowed to be.

The permission half matters more than the feature, so it leads: the sender only,
and a 404 rather than a 403 so the endpoint does not confirm that somebody else's
message exists. That matches how the room delete refuses
(`get_object_or_404(request.user.rooms.all(), ...)` -> 404 for
`test_cannot_delete_a_room_you_do_not_belong_to`) rather than how message *create*
refuses, which raises `PermissionDenied` because publishing into a room you are
not in is a different act from touching a row that is already yours.
"""
from unittest.mock import patch

import pytest

from chat.models import Message


def delete_url(message_id):
    return f'/api/v1/messages/{message_id}/delete'


@pytest.fixture
def announced():
    """Every push the model attempts, as the raw `(group, payload)` args.

    `Message.signal_to_room` does
    `async_to_sync(channel_layer.group_send)(group, payload)` and throws the
    return value away, so replacing `async_to_sync` with a recorder captures the
    send itself. A layer spy rather than a socket for the reason
    `test_message_pending.py:56-63` gives: a "nothing arrived" assertion through
    a real consumer costs the socket for the rest of the test.
    """
    sent = []

    def record(channel_layer_group_send):
        def send(*args):
            sent.append(args)
        return send

    with patch('chat.models.async_to_sync', record):
        yield sent


def pushes(announced):
    """(group, event, data) triples, so a test reads as a sentence.

    The event name is `payload['message']`, not `payload['type']`: `signal_to_room`
    hardcodes `"type": "chat_message"` -- that is the *Channels handler* name and
    every event goes through it -- and puts the name in `"message"`, which is the
    key `App.vue:43` branches on. Reading `type` here made every event look like
    a message push.
    """
    return [(group, payload['message'], payload.get('data'))
            for group, payload in announced]


# ------------------------------------------------------------------- the feature

def test_deleting_your_own_message_removes_it(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(room, user, body='see you at 8')

    assert auth_client.post(delete_url(message.id)).status_code == 204
    assert not Message.objects.filter(id=message.id).exists()


def test_only_the_message_you_named_is_removed(
        auth_client, user, other, make_room, make_message):
    """Two things in one test, because they are one rule.

    The first is obvious and the second is the one worth having: the message ids
    are a sequence, so a delete that filtered on the room instead of on the id
    would take the whole thread with it and still pass a test that only checked
    *a* message went away.
    """
    room = make_room(user, other)
    first = make_message(room, user, body='first')
    second = make_message(room, user, body='second')
    third = make_message(room, other, body='from bob')

    assert auth_client.post(delete_url(second.id)).status_code == 204

    assert list(Message.objects.filter(room=room)
                .order_by('id').values_list('body', flat=True)) == [
                    'first', 'from bob']


def test_a_deleted_message_is_gone_from_the_history(
        auth_client, user, other, make_room, make_message):
    """The end the user actually checks.

    `LastMessagesRoomAPIView` is the endpoint the client pages through, and it
    reads `Message.objects.filter(...)` at call time, so a hard delete needs no
    tombstone -- but that is an assumption worth pinning, because the moment a
    delete becomes a soft delete this test is what says so.
    """
    room = make_room(user, other)
    kept = make_message(room, user, body='kept')
    doomed = make_message(room, user, body='doomed')

    auth_client.post(delete_url(doomed.id))

    body = auth_client.get(f'/api/v1/messages/{room.id}').json()
    assert [one['id'] for one in body['messages']] == [kept.id]


# ------------------------------------------------------------------ the boundary

def test_you_cannot_delete_a_message_someone_else_sent(
        api_client, user, other, make_room, make_message):
    """The trust boundary, and the reason this is not just a button.

    Two people in one room both have every reason to reach this endpoint, so
    membership of the room cannot be the check -- authorship has to be. Without
    it, anyone a message was addressed to can delete it, and the feature becomes a
    way to censor someone else's conversation.
    """
    room = make_room(user, other)
    message = make_message(room, other, body='from bob')
    api_client.force_authenticate(user=user)

    assert api_client.post(delete_url(message.id)).status_code == 404
    assert Message.objects.filter(id=message.id).exists()


def test_cannot_delete_a_message_in_a_room_you_are_not_in(
        auth_client, user, make_user, make_room, make_message):
    """The other half, and the reason the 404 is the right code for both.

    A message in a room you were removed from is not yours and not visible, so
    answering 403 would confirm it exists. 404 is what the room delete already
    does for the same situation, and these two refusals should be indistinguishable
    from the outside.
    """
    stranger = make_user('carol')
    room = make_room(stranger, make_user('dave'))
    message = make_message(room, stranger, body='not for alice')

    assert auth_client.post(delete_url(message.id)).status_code == 404
    assert Message.objects.filter(id=message.id).exists()


def test_deleting_a_message_that_does_not_exist_is_a_404(auth_client):
    assert auth_client.post(delete_url(999999)).status_code == 404


# ------------------------------------------------------------------ the announce

def test_deleting_announces_it_to_every_participant(
        auth_client, user, other, make_room, make_message, announced):
    """Deletion is for everyone, so the socket has to say so.

    Without this the delete would remove the message for the person who clicked
    and nowhere else -- and they would only learn about it by scrolling away and
    back, which re-reads the history and makes the deletion look like a rendering
    bug. The event type and both keys are part of the contract the client matches
    on, so all three are asserted rather than the call count.

    **This expectation was amended twice, and the amendments are the interesting
    part.** The first draft had `front_key` in the payload, on the reasoning that
    `message_id` cannot clear `receivedMessages` and `sendingPool`, which are
    front_key maps. That is true of the *maps* and irrelevant in practice: the
    client already holds the message as one object, so it reads the key off the
    message it found. Carrying a second key on the wire buys nothing and is one
    more thing to keep in step -- `front_key` is a `UUIDField`, so it would also
    need stringifying or the client's own `uuid4()` string would never equal it.
    What the delete must *not* lose is the message-id half, and that is what the
    equality assertion is for: a payload carrying anything beyond the id fails
    here rather than quietly widening the contract.
    """
    room = make_room(user, other)
    message = make_message(room, user, body='see you at 8')

    auth_client.post(delete_url(message.id))

    assert pushes(announced) == [
        (f'group_general_user_{user.id}', 'message_delete',
         {'message_id': message.id}),
        (f'group_general_user_{other.id}', 'message_delete',
         {'message_id': message.id}),
    ]


def test_a_refused_delete_announces_nothing(
        api_client, user, other, make_room, make_message, announced):
    """The half that would be invisible.

    Signalling before checking would tell both participants a message was deleted
    while it was still there, so the sender's own copy would vanish and then come
    back on the next fetch with nothing having happened. The order in the view is
    what this pins.
    """
    room = make_room(user, other)
    message = make_message(room, other, body='from bob')
    api_client.force_authenticate(user=user)

    api_client.post(delete_url(message.id))

    assert announced == []
