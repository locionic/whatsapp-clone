"""The three delivery receipts, end to end, and the ones that never arrive.

`sent`, `all_received` and `all_read` used to be three spellings of a
`chat_message` carrying `update_message`, decided independently at each push
site. They are now one `delivery_receipt` event with a `kind` the consumer
knows, so the two questions worth asking are both new:

**Does each one arrive?** `test_the_author_is_told_the_server_took_the_message`
is the only one with no coverage at all -- `sent` did not exist. The other two
have always been covered from the model side by `test_message_pending.py` and
from the socket side by `test_consumer.py`, and both of those still pass
unmodified, which is the point: routing the receipts through their own event
type changed the channel-layer payload without changing a byte on the socket.

**Does anything else arrive?** A receipt is the one push with no refetch behind
it -- `update` means "go ask the API again", and a client that gets that wrong
recovers on the next poll. A client that gets a receipt wrong stays wrong, so
the consumer validates before forwarding and drops what it does not recognise.
The `DROP_*` cases below are the reason the handler exists at all: each one is
a payload that would otherwise reach App.vue, whose
`else if (message === "update_message")` commits a mutation on `message_id`
without ever checking one is there.

The drop is silent and the socket survives -- the test asserts both, because a
handler that raised instead would close the connection and take every later
push down with it.
"""
import json

import pytest
from asgiref.sync import async_to_sync, sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator

from chat.consumers import DELIVERY_RECEIPT_KINDS, ChatConsumer
from chat.models import Message

WS_URL = '/ws/notifications/'


def consumer_for(user):
    comm = WebsocketCommunicator(ChatConsumer.as_asgi(), WS_URL)
    comm.scope['user'] = user
    return comm


def pushes_after(user, data):
    """The payloads the socket gets for one receipt event, valid or not.

    An empty list means it was dropped. `receive_nothing` rather than a bounded
    read, so a handler that sent *something* is caught as readily as one that
    sent nothing.
    """
    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        await get_channel_layer().group_send(
            f'group_general_user_{user.id}',
            {'type': 'delivery_receipt', 'data': data})
        return await comm.receive_nothing()

    return async_to_sync(scenario)()


# ------------------------------------------------------------- what arrives

@pytest.mark.parametrize('kind', DELIVERY_RECEIPT_KINDS)
def test_a_receipt_of_every_kind_reaches_the_socket(user, kind):
    """All three are forwarded, each as the one envelope the client already
    dispatches on -- `update_message` with `kind` and `message_id` inside.

    `sent` has no icon of its own and does not need one: a message the server
    has taken is drawn exactly as it was before, one tick. What it settles is
    the gap an HTTP answer cannot cover -- a POST that comes back while the
    message is still in the sending pool.
    """
    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        await get_channel_layer().group_send(
            f'group_general_user_{user.id}',
            {'type': 'delivery_receipt',
             'data': {'kind': kind, 'message_id': 12}})
        return await comm.receive_from()

    assert json.loads(async_to_sync(scenario)()) == {
        'message': 'update_message',
        'data': {'kind': kind, 'message_id': 12}}


def test_a_receipt_does_not_reach_someone_else(user, other):
    """`delivery_receipt` gets its own route, so nothing carries over from the
    `chat_message` tests that already pin group scoping -- and a receipt is
    worse than useless to the wrong client: it would tick someone else's
    message."""
    async def scenario():
        comm = consumer_for(other)
        await comm.connect()
        await get_channel_layer().group_send(
            f'group_general_user_{user.id}',
            {'type': 'delivery_receipt',
             'data': {'kind': 'all_read', 'message_id': 12}})
        return await comm.receive_nothing()

    assert async_to_sync(scenario)() is True


# ------------------------------------------------------------ what is dropped

@pytest.mark.parametrize('data', [
    {'kind': 'all_read'},                        # no message to tick
    {'message_id': 12},                          # no kind: App.vue reads both
    {'kind': 'all_read', 'message_id': '12'},    # a string id reaches Vue.set
    {'kind': 'all_read', 'message_id': None},
    {'kind': 'all_read', 'message_id': 12.0},    # float, and 12.0 == 12
    {'kind': 'all_read', 'message_id': True},    # bool passes isinstance(int)
    {'kind': 'delivered', 'message_id': 12},     # the name it is usually given
    {'kind': None, 'message_id': 12},
    {'kind': 'ALL_READ', 'message_id': 12},      # case is not forgiving
    {},
])
def test_a_receipt_the_consumer_does_not_understand_is_dropped(user, data):
    """Silently. Not an error: the producer is this codebase, so a receipt the
    consumer does not know is a bug here rather than a client problem, and a
    closed socket would cost the user every other push for the price of one."""
    assert pushes_after(user, data) is True


def test_a_dropped_receipt_does_not_cost_the_socket_its_next_push(user):
    """The socket stays useful. `receive_nothing` says nothing was *sent*, not
    that anything was *broken*, so the connection has to be shown working
    afterwards -- a handler that raised would pass every drop test above and
    leave the client deaf."""
    async def scenario():
        comm = consumer_for(user)
        await comm.connect()
        layer = get_channel_layer()
        await layer.group_send(
            f'group_general_user_{user.id}',
            {'type': 'delivery_receipt', 'data': {'kind': 'delivered',
                                                 'message_id': 12}})
        assert await comm.receive_nothing()
        await layer.group_send(
            f'group_general_user_{user.id}',
            {'type': 'delivery_receipt',
             'data': {'kind': 'all_read', 'message_id': 12}})
        return await comm.receive_from()

    assert json.loads(async_to_sync(scenario)()) == {
        'message': 'update_message',
        'data': {'kind': 'all_read', 'message_id': 12}}


@pytest.mark.parametrize('data', [None, 'all_read', 12, ['all_read', 12]])
def test_a_receipt_that_is_not_a_payload_is_dropped(user, data):
    """`event.get('data')` is None when the key is missing altogether, and
    `isinstance` catches the shapes a dict check alone would not -- a string
    payload answers `.get` with an AttributeError, which closes the socket."""
    assert pushes_after(user, data) is True


# ------------------------------------------------------- the author, on send

def test_the_author_is_told_the_server_took_the_message(
        auth_client, user, other, make_room):
    """The `sent` receipt, and the reason it is worth a socket message.

    A sender gets 'update' too, but `update` is a *refetch* command: it tells
    every participant to go and read the API again. The author has nothing to
    refetch -- their POST is what they were already waiting on, and it comes
    back with the created row. So on the one event that matters most to them,
    the one that says the server accepted what they typed, the client was told
    to make a request for a message it had just been handed.
    """
    room = make_room(user, other)

    async def scenario():
        comm = consumer_for(user)
        await comm.connect()

        def post_and_read():
            response = auth_client.post('/api/v1/messages/',
                                        {'room': room.id, 'body': 'hello'},
                                        format='json')
            assert response.status_code == 201
            return Message.objects.get(room=room, author=user).id

        # Both in one call, because a read *after* this one cannot open a
        # connection at all. CONN_MAX_AGE is 0 here, so `close_old_connections`
        # closes unconditionally, and channels' `AsyncConsumer.dispatch` calls it
        # before every handler -- thread-sensitive, so it runs on the test's own
        # thread, still inside the test's atomic block, which marks the
        # connection closed-in-transaction. This one read lands while the
        # connection is still usable, which is the only window there is.
        created_id = await sync_to_async(post_and_read)()

        # Two pushes, not one: the author is a participant, so the room-wide
        # `update` is first and the receipt to them alone is second.
        assert json.loads(await comm.receive_from()) == {'message': 'update',
                                                         'data': {}}
        return json.loads(await comm.receive_from()), created_id

    push, created_id = async_to_sync(scenario)()

    # Keyed on the message that was actually created, not a fixed number: a
    # receipt naming some other row would tick a message the author never sent,
    # and the payload alone would look right. The 201 body cannot be used for
    # this -- create() answers with CreateMessageSerializer, which carries
    # front_key and no id.
    assert push == {
        'message': 'update_message',
        'data': {'message_id': created_id, 'kind': 'sent'}}


def test_the_sent_receipt_does_not_go_out_to_the_room(
        auth_client, user, other, make_room):
    """The author alone. Every other participant is told 'update' and refetches
    the room -- where the serializer tells them whether it has arrived -- so a
    `sent` pushed to the room would tick a message the recipients have not even
    seen yet."""
    room = make_room(user, other)

    async def scenario():
        comm = consumer_for(other)
        await comm.connect()
        await sync_to_async(auth_client.post)(
            '/api/v1/messages/',
            {'room': room.id, 'body': 'hello'},
            format='json')
        first = json.loads(await comm.receive_from())
        return first, await comm.receive_nothing()

    first, nothing_left = async_to_sync(scenario)()

    assert first == {'message': 'update', 'data': {}}
    assert nothing_left is True
