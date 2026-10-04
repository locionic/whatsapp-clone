"""ChatConsumer rules. The websocket is the only real-time surface and it had
no coverage at all.

Driven from sync tests with asgiref.async_to_sync rather than pytest-asyncio,
which is not a dependency here. Each test wraps its whole scenario in one
coroutine: async_to_sync gets a fresh event loop per call, and a channel-layer
group_send from a different loop than the consumer's gets cancelled.
"""
import json

import pytest
from django.contrib.auth.models import AnonymousUser
from asgiref.sync import async_to_sync, sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator

from chat.consumers import ChatConsumer
from friends.models import Friend
from djchat.asgi import application

WS_URL = '/ws/notifications/'


def consumer_for(user):
    """The bare consumer, so the test controls scope['user'].

    The full application would overwrite it from the session cookie."""
    comm = WebsocketCommunicator(ChatConsumer.as_asgi(), WS_URL)
    comm.scope['user'] = user
    return comm


def test_anonymous_connections_are_refused():
    """Through the real middleware stack: with no session cookie,
    AuthMiddlewareStack resolves scope['user'] to AnonymousUser."""
    async def scenario():
        return (await WebsocketCommunicator(application, WS_URL).connect())[0]

    assert async_to_sync(scenario)() is False


def test_an_anonymous_user_cannot_join_the_consumer_either():
    async def scenario():
        return (await consumer_for(AnonymousUser()).connect())[0]

    assert async_to_sync(scenario)() is False


def test_a_signed_in_user_connects(user):
    async def scenario():
        return (await consumer_for(user).connect())[0]

    assert async_to_sync(scenario)() is True


def test_a_broadcast_reaches_a_connected_client(user):
    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        await get_channel_layer().group_send(
            f'group_general_user_{user.id}',
            {'type': 'chat_message', 'message': 'update', 'data': {'room_id': 7}})
        return await comm.receive_from()

    assert async_to_sync(scenario)() == json.dumps(
        {'message': 'update', 'data': {'room_id': 7}})


def test_a_broadcast_for_another_user_does_not_reach_you(user, other):
    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        await get_channel_layer().group_send(
            f'group_general_user_{other.id}',
            {'type': 'chat_message', 'message': 'update', 'data': {}})
        return await comm.receive_nothing()

    assert async_to_sync(scenario)() is True


@pytest.fixture
def discards(monkeypatch):
    """Record every group_discard on the shared channel layer.

    BaseConsumer.__call__ resolves the layer with get_channel_layer() and
    ignores scope['channel_layer'], so the recording has to be on the layer
    instance the consumer will actually get.
    """
    seen = []
    layer = get_channel_layer()
    original = layer.group_discard

    async def record(group, channel):
        seen.append(group)
        return await original(group, channel)

    monkeypatch.setattr(layer, 'group_discard', record)
    return seen


def test_a_disconnecting_socket_leaves_its_users_group(user, discards):
    """disconnect() had no coverage at all. A channel that stays in the group
    keeps receiving every broadcast addressed to that user, so the leak is
    silent -- no error, just someone else's notifications after they left."""
    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        await comm.disconnect()

    async_to_sync(scenario)()

    assert discards == [f'group_general_user_{user.id}']


def test_a_client_that_comes_back_rejoins_its_group(user, db):
    """A reconnect has to re-add the channel to the user's group, or it
    looks healthy -- onopen fires, no error -- and simply receives nothing
    again. App.vue is free to retry after a daphne restart, and that retry is
    only safe because of this."""
    async def scenario():
        first = consumer_for(user)
        await first.connect()
        await first.disconnect()

        second = consumer_for(user)
        await second.connect()
        await get_channel_layer().group_send(
            f'group_general_user_{user.id}',
            {'type': 'chat_message', 'message': 'update', 'data': {}})
        return await second.receive_from()

    assert json.loads(async_to_sync(scenario)()) == {
        'message': 'update', 'data': {}}


def test_a_refused_socket_does_not_try_to_leave_a_group(discards, db):
    """connect() sets room_group_name to None before it refuses, so a refused
    socket has nothing to discard and must not reach for a group it never
    joined. `db` because BaseConsumer.__call__ runs close_old_connections on
    the way out, refused or not."""
    async def scenario():
        comm = consumer_for(AnonymousUser())
        await comm.connect()
        await comm.disconnect()

    async_to_sync(scenario)()

    assert discards == []


# ------------------------------------------------------- http -> websocket

def test_posting_a_message_reaches_a_connected_participant(
        auth_client, user, other, make_room):
    """The seam between the two halves.

    ChatConsumer.chat_message reads both 'message' and 'data' out of the
    event, so a sender that dropped either one raises KeyError inside the
    handler and closes that participant's socket for good. Nothing caught it:
    the socket tests here hand-write their own payloads, and the API tests
    never open one -- deleting 'data' from messageViews.create left all 159
    tests green.
    """
    room = make_room(user, other)

    def send():
        return auth_client.post(
            '/api/v1/messages/',
            {'room': room.id, 'body': 'hello'},
            format='json')

    async def scenario():
        comm = consumer_for(other)
        await comm.connect()
        response = await sync_to_async(send)()
        assert response.status_code == 201
        return await comm.receive_from()

    assert json.loads(async_to_sync(scenario)()) == {
        'message': 'update', 'data': {}}


def push_received_by(listener, action):
    """Open `listener`'s socket, run the sync HTTP `action`, return the payload.

    Every push the frontend consumes is a plain dict, so a key renamed on
    this side reaches App.vue as undefined and the handler quietly does
    nothing -- no error, the chat just stops updating. These four keys are
    read there and nowhere else:
        update_received -> fetchReceivedInvitations
        update_sent     -> fetchSentInvitations
        update_rooms    -> fetchRooms
        room_delete     -> const { room_id } = data.data
        writing         -> EventBus.$emit("writing", data.data)
        update_message  -> const { kind, message_id } = data.data
    """
    return pushes_received_by(listener, action, 1)[0]


def pushes_received_by(listener, action, count=1):
    """The first `count` payloads `listener` gets while `action` runs.

    Count > 1 where one action legitimately pushes to the same socket twice:
    accepting fires Room.signal_to_room (both participants) and then the
    sender's own update_sent, so the sender sees update_rooms first.
    """
    async def scenario():
        comm = consumer_for(listener)
        await comm.connect()
        await sync_to_async(action)()
        return [json.loads(await comm.receive_from()) for _ in range(count)]

    return async_to_sync(scenario)()


def test_acking_the_last_receiver_pushes_all_received(
        api_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(room, user, 'hi', pending_reception=[other])
    api_client.force_authenticate(user=other)

    assert push_received_by(other, lambda: api_client.get('/api/v1/messages/')) == {
        'message': 'update_message',
        'data': {'message_id': message.id, 'kind': 'all_received'}}


def test_reading_the_last_reader_pushes_all_read(
        api_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(room, user, 'hi', pending_read=[other])
    api_client.force_authenticate(user=other)

    assert push_received_by(
        other,
        lambda: api_client.post(
            f'/api/v1/messages/unread?message_id={message.id}')
    ) == {'message': 'update_message',
          'data': {'message_id': message.id, 'kind': 'all_read'}}


def test_deleting_a_room_pushes_the_room_id(auth_client, user, other, make_room):
    room = make_room(user, other)

    assert push_received_by(
        other, lambda: auth_client.post(f'/api/v1/rooms/{room.id}/delete')
    ) == {'message': 'room_delete', 'data': {'room_id': room.id}}


def test_signalling_that_you_are_writing_pushes_both_ids(
        auth_client, user, other, make_room):
    room = make_room(user, other)

    assert push_received_by(
        other, lambda: auth_client.post(f'/api/v1/rooms/{room.id}/writing')
    ) == {'message': 'writing',
          'data': {'user_id': user.id, 'room_id': room.id}}


def test_signalling_that_you_are_writing_does_not_echo_back_to_the_typist(
        auth_client, user, other, make_room):
    """`room.participants.exclude(id=request.user.id)` is load-bearing and was
    untested. `User.vue:120` filters a writing push on `room_id` alone -- there
    is no `user_id` check -- so a push delivered back to its own sender renders
    as their name above the chat they are typing in, until the ten-second
    timeout clears it. Reverting the `.exclude` to `.all()` was green on all
    250 tests: `push_received_by` opens only the listener's socket, so nothing
    was watching the sender's.
    """
    room = make_room(user, other)

    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        await sync_to_async(auth_client.post)(
            f'/api/v1/rooms/{room.id}/writing')
        return await comm.receive_nothing()

    assert async_to_sync(scenario)() is True


# -------------------------------------------------------- rejecting a request

def test_the_sender_is_told_when_their_invitation_is_rejected(user, other):
    """reject() fired friendship_request_rejected with no receiver bound, so
    the sender's open socket never heard about it and the client kept showing
    a pending invitation that had already been turned down. 'update_sent' is
    the message App.vue answers with fetchSentInvitations."""
    request = Friend.objects.add_friend(user, other)

    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        # reject() is sync code that async_to_sync(group_send)s, so it has to
        # be handed to a thread for the send to land on the consumer's loop.
        await sync_to_async(request.reject)()
        return await comm.receive_from()

    assert json.loads(async_to_sync(scenario)()) == {
        'message': 'update_sent', 'data': {}}


def test_rejecting_does_not_notify_the_rejecter(user, other):
    """Only the sender is left holding a stale list -- the rejecter made the
    call, and the reject view answers them over HTTP directly."""
    request = Friend.objects.add_friend(user, other)

    async def scenario():
        comm = consumer_for(other)
        await comm.connect()
        await sync_to_async(request.reject)()
        return await comm.receive_nothing()

    assert async_to_sync(scenario)() is True


# --------------------------------------------------- the other friendship events

def test_sending_an_invitation_reaches_the_receiver(user, other):
    """add_friend fired friendship_request_created, whose receiver pushed
    'update_received' -- to to_user. Sending it to from_user instead, or
    renaming the message, left all 167 tests green: the receiver's client
    would just never hear about the invitation."""
    assert push_received_by(
        other, lambda: Friend.objects.add_friend(user, other)) == {
            'message': 'update_received', 'data': {}}


def test_cancelling_an_invitation_reaches_the_receiver(user, other):
    """cancel() deletes the row, so the receiver's list has to be refetched
    or they keep a card they can no longer act on. The push goes to to_user --
    the person who did not press the button."""
    request = Friend.objects.add_friend(user, other)

    assert push_received_by(other, request.cancel) == {
        'message': 'update_received', 'data': {}}


def test_accepting_tells_both_of_them_to_refetch_rooms(user, other):
    """accept() creates the private room, so both sides need a fresh room
    list; the sender only learns about it from the push."""
    request = Friend.objects.add_friend(user, other)

    assert push_received_by(other, request.accept) == {
        'message': 'update_rooms', 'data': {}}


def test_accepting_tells_the_sender_to_refetch_their_sent_list(user, other):
    """The second push to the sender: update_rooms first (both participants),
    then update_sent, which is what drops the invitation from the sent tab.
    Reading only the first push would have let this one drift unnoticed."""
    request = Friend.objects.add_friend(user, other)

    assert pushes_received_by(user, request.accept, 2) == [
        {'message': 'update_rooms', 'data': {}},
        {'message': 'update_sent', 'data': {}}]


# --------------------------------------------------------- creating a room

def test_creating_a_group_tells_the_members_it_was_created_for(
        auth_client, user, other, make_user):
    """A new group is the only room the backend can make without anyone else
    acting first, and create() was the one push site that pushed nothing: the
    people added to it saw no room until they reloaded by hand.

    'update_rooms' is what App.vue already answers with fetchRooms, so this
    reuses the message the accept signal sends -- no new type for the client
    to learn.
    """
    carol = make_user('carol')

    assert push_received_by(other, lambda: auth_client.post(
        '/api/v1/rooms/',
        {'kind': 2, 'group_name': 'Team',
         'participants': [other.id, carol.id]},
        format='json')) == {'message': 'update_rooms', 'data': {}}


def test_the_creator_is_told_too(auth_client, user, other):
    """Refetching is one request; skipping the creator would need a second code
    path through signal_to_room to save it."""
    assert push_received_by(user, lambda: auth_client.post(
        '/api/v1/rooms/',
        {'kind': 2, 'group_name': 'Team', 'participants': [other.id]},
        format='json')) == {'message': 'update_rooms', 'data': {}}


def test_a_group_creation_reaches_everyone_it_names(
        auth_client, user, other, make_user):
    """signal_to_room iterates the participants, so a member added later in the
    list must not be skipped -- a group of ten is not a group of one."""
    carol = make_user('carol')

    assert push_received_by(carol, lambda: auth_client.post(
        '/api/v1/rooms/',
        {'kind': 2, 'group_name': 'Team',
         'participants': [other.id, carol.id]},
        format='json')) == {'message': 'update_rooms', 'data': {}}


def test_opening_a_private_chat_that_already_exists_pushes_nothing(
        auth_client, user, other, make_room):
    """POST /rooms with kind=1 is idempotent: both are already in that room and
    already have it. The push is on `created`, not on every call, so re-opening
    a chat does not make the other person refetch for nothing.

    `receive_nothing`, not an empty read list -- counting zero receives would
    pass without ever looking at the socket.
    """
    make_room(user, other)

    def open_chat():
        return auth_client.post(
            '/api/v1/rooms/',
            {'kind': 1, 'participants': [other.id]},
            format='json')

    async def scenario():
        comm = consumer_for(other)
        await comm.connect()
        response = await sync_to_async(open_chat)()
        assert response.status_code == 200  # not created
        return await comm.receive_nothing()

    assert async_to_sync(scenario)() is True


def test_a_private_room_built_here_does_reach_the_other_person(
        auth_client, user, other):
    """The other half of the guard: get_or_create_private can also return
    created=True here, and then the other person genuinely has no such room."""
    assert push_received_by(other, lambda: auth_client.post(
        '/api/v1/rooms/',
        {'kind': 1, 'participants': [other.id]},
        format='json')) == {'message': 'update_rooms', 'data': {}}