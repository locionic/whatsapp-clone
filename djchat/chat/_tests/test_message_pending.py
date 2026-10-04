"""All received, all read -- and only once the last person is there.

`messageViews.py` seeds a new message like this:

    message.pending_reception.set(room.participants.all())
    message.pending_read.set(room.participants.exclude(id=user.id))

so a three-person group starts with three pending for reception and two for
reading. `Message.remove_user_from_pending` and `Message.mark_as_read` each take
one user off their set and announce the outcome **only if nothing is left**:

    if not self.pending_reception.exists():
        self.signal_to_room('update_message', {..., 'kind': 'all_received'})

That "only if" is the whole contract, and it is what `User.vue` draws: one tick
until `all_received`, two until `all_read`. It is also the last block of the TODO
list in `message_test.py`, which had never been written.

The two tests next door in `test_consumer.py` cover the firing half -- and do it
with a single user pending, so the guard is always about to be true. Nothing
covered the other half. Deleting both guards leaves every test in this project
passing: the push would fire on the *first* participant to open a chat rather
than the last, and the single tick would turn double for everyone else. These are
the tests that notice.

No socket is involved. What is under test is a decision -- whether to announce at
all -- and `test_consumer.py` already pins that the announcement, when made,
arrives with the right shape and reaches the right client.
"""
import json
from unittest.mock import patch

import pytest

from chat.models import Room

# method, the set it clears, the kind it announces, and who is pending when the
# message is sent -- reception includes the author, read does not.
KINDS = [
    ('remove_user_from_pending', 'pending_reception', 'all_received',
     ('alice', 'bob', 'carol')),
    ('mark_as_read', 'pending_read', 'all_read',
     ('bob', 'carol')),
]


@pytest.fixture
def announced():
    """Every push the model attempts, as `(group_name, payload)`.

    `signal_to_room` does `async_to_sync(channel_layer.group_send)(group, payload)`
    and throws the return value away, so replacing `async_to_sync` with a recorder
    captures the send itself. A layer spy rather than a socket because the
    question here is whether a push happens at all: `receive_output` raises
    `asyncio.TimeoutError` on timeout *and* cancels the communicator's
    application task, so a "nothing arrived" assertion that way would cost the
    socket for the rest of the test.
    """
    sent = []

    def record(channel_layer_group_send):
        def send(*args):
            sent.append(args)
        return send

    with patch('chat.models.async_to_sync', record):
        yield sent


def people(make_user):
    return {name: make_user(name) for name in ('alice', 'bob', 'carol')}


@pytest.mark.parametrize('method, pending_attr, kind, pending', KINDS)
def test_the_announcement_waits_for_the_last_person(
        method, pending_attr, kind, pending, make_user, make_room, make_message,
        announced):
    users = people(make_user)
    room = make_room(*users.values(), kind=Room.RoomKind.GROUP, group_name='Team')
    message = make_message(
        room, users['alice'], 'hi',
        **{pending_attr: [users[name] for name in pending]})

    cleared = []
    for name in list(pending)[:-1]:
        getattr(message, method)(users[name])
        cleared.append(name)

        assert announced == [], f'{name} is not the last one pending'
        assert set(getattr(message, pending_attr).values_list('id', flat=True)) \
            == {users[n].id for n in pending if n not in cleared}

    getattr(message, method)(users[pending[-1]])

    # Once per participant, not once per person who cleared their set -- the push
    # is addressed to everyone in the room, and each renders its own ticks from it.
    assert len(announced) == 3
    assert {group for group, _ in announced} == {
        f'group_general_user_{user.id}' for user in users.values()}
    assert {json.dumps(payload, sort_keys=True) for _, payload in announced} == {
        json.dumps({
            'type': 'chat_message',
            'message': 'update_message',
            'data': {'message_id': message.id, 'kind': kind},
        }, sort_keys=True)}
    assert not getattr(message, pending_attr).exists()


@pytest.mark.parametrize('method, pending_attr, kind, pending', KINDS)
def test_asking_twice_announces_nothing_the_second_time(
        method, pending_attr, kind, pending, make_user, make_room, make_message,
        announced):
    """Not just an edge case. `get_last_message()` calls
    `remove_user_from_pending(current_user)` every single time a room is
    serialized, so the already-cleared path is the common one, not the rare one.
    Announcing again would tick a message that has not changed."""
    users = people(make_user)
    room = make_room(*users.values(), kind=Room.RoomKind.GROUP, group_name='Team')
    message = make_message(
        room, users['alice'], 'hi',
        **{pending_attr: [users[name] for name in pending]})

    for name in pending:
        getattr(message, method)(users[name])
    assert len(announced) == 3, 'the first pass should announce'

    for name in pending:
        getattr(message, method)(users[name])

    assert len(announced) == 3, 'a second pass announced again'