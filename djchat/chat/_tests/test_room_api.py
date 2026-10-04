"""Room creation rules, transcribed from the plan in `_tests/room_test.py`."""
import re
from pathlib import Path

from django.urls import reverse
from django.utils.dateparse import parse_datetime as dateparse

from chat.api.serializers import (
    CreateRoomSerializer, MessageSerializer, RoomSerializer)
from chat.models import Room
from friends.models import Friend
from users.api.serializers import UserSerializer

from conftest import GROUP, PRIVATE


def create(api_client, **payload):
    return api_client.post(reverse('room-list'), payload, format='json')


# ---------------------------------------------------------------- required fields

def test_private_requires_kind(auth_client):
    assert create(auth_client, participants=[]).status_code == 400


def test_private_requires_participants(auth_client, other):
    assert create(auth_client, kind=PRIVATE).status_code == 400


def test_kind_must_be_valid(auth_client, other):
    assert create(auth_client, kind=99, participants=[other.id]).status_code == 400


def test_rejects_unknown_participant(auth_client):
    assert create(auth_client, kind=PRIVATE, participants=[9999]).status_code == 400


def test_rejects_an_empty_participant_list(auth_client):
    assert create(auth_client, kind=PRIVATE, participants=[]).status_code == 400
    assert Room.objects.count() == 0


# ------------------------------------------------------------------ private chats

def test_private_with_only_the_author_is_rejected(auth_client, user):
    assert create(auth_client, kind=PRIVATE, participants=[user.id]).status_code == 400


def test_private_naming_the_author_twice_is_rejected(auth_client, user):
    """The guard above asks "is the author alone?", which is a question about
    distinct people -- and answered it with a count. `[user.id]` is one entry,
    so it is caught; `[user.id, user.id]` is two, so it is not, and the append
    below is skipped because the author is already in the list.

    What that leaves is a private room with the author as its *only*
    participant, written before the serializer can complain -- `get_or_create_
    private` adds the same user twice, which is one row. Three readers then
    index past the end of a one-element list:

      - RoomSerializer.get_group_name -> `participants[0]`, which is what
        raises, from the response to this very request.
      - GET /api/v1/rooms/ and /rooms/recents, i.e. the app's first two calls
        on load.
      - POST /rooms/<id>/delete, `participants[1]` -- the one endpoint that
        could have cleaned it up.

    So a single malformed request leaves an account that cannot list its rooms
    and cannot delete the room that is causing it. Each of those is a 500,
    and none of them is reachable once the row is written.
    """
    r = create(auth_client, kind=PRIVATE, participants=[user.id, user.id])

    assert r.status_code == 400
    # Nothing written: a rejected request must not leave a room behind, since
    # the room -- not the 500 -- is what makes this unrecoverable.
    assert Room.objects.count() == 0
    # And the control: the author's rooms still list.
    assert auth_client.get(reverse('room-list')).status_code == 200


def test_private_with_two_others_is_rejected(auth_client, user, other, make_user):
    carol = make_user('carol')
    r = create(auth_client, kind=PRIVATE, participants=[other.id, carol.id])
    assert r.status_code == 400


def test_private_with_two_others_plus_author_is_rejected(auth_client, user, other, make_user):
    carol = make_user('carol')
    r = create(auth_client, kind=PRIVATE, participants=[user.id, other.id, carol.id])
    assert r.status_code == 400


def test_private_adds_the_author_when_omitted(auth_client, user, other):
    r = create(auth_client, kind=PRIVATE, participants=[other.id])
    assert r.status_code == 201
    assert set(Room.objects.get().participants.values_list('id', flat=True)) == {
        user.id, other.id}


def test_private_accepts_the_author_alongside_one_other(auth_client, user, other):
    r = create(auth_client, kind=PRIVATE, participants=[user.id, other.id])
    assert r.status_code == 201
    assert Room.objects.count() == 1


def test_private_room_is_not_duplicated(auth_client, other):
    first = create(auth_client, kind=PRIVATE, participants=[other.id])
    second = create(auth_client, kind=PRIVATE, participants=[other.id])
    assert first.status_code == 201
    assert second.status_code == 200
    assert Room.objects.count() == 1


def test_a_private_chat_ignores_a_group_both_of_them_are_in(
        auth_client, user, other, make_room):
    """`get_or_create_private` is asked for *the one private room for these two*,
    and the two chained filters are the whole of what makes its answer that
    question. Drop `kind=RoomKind.PRIVATE` and it becomes "any room with both of
    them in it" -- so a group the two of them share comes back as their private
    chat: the group, with everyone in it, under the name of a conversation
    between two. `.first()` orders by pk, so the *older* room wins, which is why
    the group has to be created first here.

    The test above is the two-person case and cannot see this. Reverting the
    kind filter was green on all 257.
    """
    group = make_room(user, other, kind=GROUP, group_name='Team')

    r = create(auth_client, kind=PRIVATE, participants=[other.id])

    # kind first: it is the assertion that names the defect. Left last, the
    # status code fires first and the failure says only "expected 201, got
    # 200" -- which sends you to look at status codes instead of at the query.
    assert r.data['kind'] == PRIVATE
    assert r.data['id'] != group.id
    assert set(r.data['participants']) == {user.id, other.id}
    assert r.status_code == 201


def test_private_ignores_a_supplied_group_name(auth_client, other):
    create(auth_client, kind=PRIVATE, participants=[other.id], group_name='sneaky')
    assert Room.objects.get().group_name is None


# --------------------------------------------------------------------- group chats

def test_group_requires_a_name(auth_client, other):
    assert create(auth_client, kind=GROUP, participants=[other.id]).status_code == 400


def test_group_with_blank_name_is_rejected(auth_client, other):
    r = create(auth_client, kind=GROUP, participants=[other.id], group_name='   ')
    assert r.status_code == 400


def test_group_with_name_is_created(auth_client, other):
    r = create(auth_client, kind=GROUP, participants=[other.id], group_name='Crew')
    assert r.status_code == 201
    assert Room.objects.get().group_name == 'Crew'


def test_group_allows_many_others(auth_client, user, other, make_user):
    carol = make_user('carol')
    r = create(auth_client, kind=GROUP, participants=[other.id, carol.id], group_name='Crew')
    assert r.status_code == 201
    assert Room.objects.get().participants.count() == 3


def test_group_accepts_the_author_alongside_one_other(auth_client, user, other):
    """`si hay 2 con autor permitir`"""
    r = create(auth_client, kind=GROUP, participants=[user.id, other.id],
               group_name='Crew')
    assert r.status_code == 201
    assert Room.objects.get().participants.count() == 2


def test_group_naming_the_author_twice_is_rejected(auth_client, user):
    """The same `[me, me]` list, on the other branch -- and the only thing
    standing between it and a group with one member.

    The "at least one another participant" guard sits above the kind check, so
    it is this test, and not the private one above, that pins *where* the
    distinct count lives. Both kinds need it: private rooms additionally trip
    the "exactly 2" check, so they would be rejected even if the count went
    back to being a length (which is what makes the dedupe mutation pass them).
    A group has no such check, so with the guard weakened this creates a room
    the author is the sole member of -- no 500, just a group that can never be
    anyone's.
    """
    r = create(auth_client, kind=GROUP, participants=[user.id, user.id],
               group_name='Crew')

    assert r.status_code == 400
    assert Room.objects.count() == 0


def test_groups_with_the_same_name_are_distinct_rooms(auth_client, other):
    create(auth_client, kind=GROUP, participants=[other.id], group_name='Crew')
    create(auth_client, kind=GROUP, participants=[other.id], group_name='Crew')
    assert Room.objects.count() == 2


# ------------------------------------------------------------------- group naming

def test_group_name_reports_the_other_participant_for_private(auth_client, user, other):
    create(auth_client, kind=PRIVATE, participants=[other.id])
    assert Room.objects.get().group_name is None
    # the API surfaces the peer's name instead of the stored name
    listing = auth_client.get(reverse('room-list'))
    assert listing.data['rooms'][0]['group_name'] == other.username


# ------------------------------------------------------------- authorization

def test_requires_authentication(api_client, other):
    assert create(api_client, kind=PRIVATE, participants=[other.id]).status_code in (401, 403)


# -------------------------------------------------------------- mark room as read

def read_url(room_id):
    return f'/api/v1/rooms/{room_id}/read'


def test_mark_room_as_read(auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    one = make_message(room, other, 'one', pending_read=[user, other])
    two = make_message(room, other, 'two', pending_read=[user])

    assert auth_client.post(read_url(room.id)).status_code == 204

    one.refresh_from_db()
    two.refresh_from_db()
    # read for me only -- `other` still has both unread
    assert list(one.pending_read.all()) == [other]
    assert list(two.pending_read.all()) == []


def test_mark_room_as_read_leaves_other_rooms_alone(auth_client, user, other, make_room, make_message):
    first = make_room(user, other)
    second = make_room(user, other)
    in_first = make_message(first, other, 'one', pending_read=[user])
    in_second = make_message(second, other, 'two', pending_read=[user])

    auth_client.post(read_url(first.id))

    in_first.refresh_from_db()
    in_second.refresh_from_db()
    assert list(in_first.pending_read.all()) == []
    assert list(in_second.pending_read.all()) == [user]


def test_cannot_mark_a_room_you_do_not_belong_to(auth_client, other, make_user, make_room, make_message):
    stranger = make_user('carol')
    room = make_room(other, stranger)
    make_message(room, other, 'hi', pending_read=[stranger])

    assert auth_client.post(read_url(room.id)).status_code == 404


# ---------------------------------------------------------------- writing signal

def writing_url(room_id):
    return f'/api/v1/rooms/{room_id}/writing'


def test_can_signal_writing_in_a_room_you_belong_to(auth_client, user, other, make_room):
    room = make_room(user, other)
    assert auth_client.post(writing_url(room.id)).status_code == 204


def test_cannot_signal_writing_in_a_room_you_do_not_belong_to(
        auth_client, other, make_user, make_room):
    stranger = make_user('carol')
    room = make_room(other, stranger)
    assert auth_client.post(writing_url(room.id)).status_code == 404


def test_writing_requires_authentication(api_client, user, other, make_room):
    room = make_room(user, other)
    assert api_client.post(writing_url(room.id)).status_code in (401, 403)


# -------------------------------------------------------------------- delete room

def delete_url(room_id):
    return f'/api/v1/rooms/{room_id}/delete'


def test_delete_room(auth_client, user, other, make_room):
    room = make_room(user, other)

    assert auth_client.post(delete_url(room.id)).status_code == 204
    assert not Room.objects.filter(id=room.id).exists()


def test_cannot_delete_a_room_you_do_not_belong_to(auth_client, other, make_user, make_room):
    stranger = make_user('carol')
    room = make_room(other, stranger)

    assert auth_client.post(delete_url(room.id)).status_code == 404
    assert Room.objects.filter(id=room.id).exists()


def test_deleting_a_private_room_ends_the_friendship(auth_client, user, other, make_room):
    Friend.objects.add_friend(user, other).accept()
    room = make_room(user, other)
    assert Friend.objects.are_friends(user, other) is True

    assert auth_client.post(delete_url(room.id)).status_code == 204
    assert Friend.objects.are_friends(user, other) is False


def test_deleting_a_private_room_as_the_other_participant_ends_the_friendship(
        api_client, user, other, make_room):
    """Exercises the branch where the requester is not participants[0]:
    the peer must still be identified correctly."""
    Friend.objects.add_friend(user, other).accept()
    room = make_room(user, other)

    api_client.force_authenticate(user=other)
    assert api_client.post(delete_url(room.id)).status_code == 204
    assert Friend.objects.are_friends(user, other) is False


def test_deleting_a_group_room_keeps_friendships(auth_client, user, other, make_room):
    Friend.objects.add_friend(user, other).accept()
    room = make_room(user, other, kind=GROUP, group_name='Crew')

    assert auth_client.post(delete_url(room.id)).status_code == 204
    assert Friend.objects.are_friends(user, other) is True


# --------------------------------------------------------------------- room list

def test_room_list_only_contains_rooms_you_belong_to(
        auth_client, user, other, make_user, make_room):
    mine = make_room(user, other)
    make_room(other, make_user('stranger'))

    ids = [r['id'] for r in auth_client.get(reverse('room-list')).data['rooms']]
    assert ids == [mine.id]


def test_room_list_carries_the_people_it_names(
        auth_client, user, other, make_room):
    """`fetchRooms` hands `response.data.users` to `syncDB` and `SET_USERS` keys
    that map by id -- this response is what fills `state.users`, and two readers
    resolve against it: `User.vue:126` looks a typing push's `user_id` up to
    name the indicator, and `ReceivedMessage.vue` does the same for a message
    author. Emptied, `:127` falls back to "" and the indicator never names
    anyone, with no error anywhere. Reverting the union to `set()` was green on
    all 250 tests, in this endpoint and in the byte-identical loop twenty lines
    below it.
    """
    make_room(user, other)

    for url in (reverse('room-list'), recents_url()):
        assert {u['id'] for u in auth_client.get(url).data['users']} == \
            {user.id, other.id}, url


# ----------------------------------------------------------------------- recents

def recents_url():
    return '/api/v1/rooms/recents'


def test_recents_orders_rooms_by_activity(auth_client, user, other, make_room):
    older = make_room(user, other)
    newer = make_room(user, other)

    ids = [r['id'] for r in auth_client.get(recents_url()).data['rooms']]
    assert ids == [newer.id, older.id]


def test_recents_only_contains_rooms_you_belong_to(
        auth_client, user, other, make_user, make_room):
    mine = make_room(user, other)
    make_room(other, make_user('stranger'))

    ids = [r['id'] for r in auth_client.get(recents_url()).data['rooms']]
    assert ids == [mine.id]


def test_recents_carries_the_last_message_of_each_room(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, other, 'first', pending_reception=[user])
    last = make_message(room, other, 'last', pending_reception=[user])

    data = auth_client.get(recents_url()).data

    assert data['rooms'][0]['last_message'] == last.id
    assert [m['id'] for m in data['messages']] == [last.id]


def test_rooms_carry_the_activity_timestamp(auth_client, user, other, make_room):
    """UsersSection.vue sorts the room list on it and User.vue formats it as
    the chat header time; RoomSerializer uses `fields = '__all__'`, so nothing
    said `last_activity` had to stay in the payload. Dropping it left all 164
    tests green and the client would have rendered 'Invalid Date'."""
    room = make_room(user, other)

    data = auth_client.get(recents_url()).data

    assert data['rooms'][0]['last_activity']
    assert dateparse(data['rooms'][0]['last_activity']) >= room.created_at


def test_a_message_not_seen_in_recents_stays_pending(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(room, other, 'unseen', pending_reception=[user])

    # no recents call -- it has not been viewed, so it is still owed to me
    assert [m['id'] for m in auth_client.get(reverse('message-list')).data['messages']] \
        == [message.id]


def test_a_message_seen_in_recents_is_no_longer_pending(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, other, 'seen', pending_reception=[user])

    auth_client.get(recents_url())

    assert auth_client.get(reverse('message-list')).data['messages'] == []


# ----------------------------------------------------------------- private profile

def test_private_room_exposes_the_other_participants_profile(auth_client, user, other, make_room):
    other.tagline = 'about bob'
    other.save()
    make_room(user, other)

    room = auth_client.get(reverse('room-list')).data['rooms'][0]

    assert room['group_name'] == other.username
    # Whole dict: `username` drives the avatar and heading in
    # ContactProfile.vue, `tagline` the Description line. Asserting only `id`
    # and `tagline` let `username` be dropped from UserSerializer unnoticed.
    assert room['group_profile'] == {
        'id': other.id, 'username': other.username,
        'email': other.email, 'tagline': 'about bob'}


def test_group_room_profile_exposes_the_group_name(auth_client, user, other):
    """A group has no single profile, but ContactProfile.vue reads
    `group_profile.username` for its avatar and heading. It used to get the
    bare name string, so every group profile rendered blank."""
    create(auth_client, kind=GROUP, participants=[other.id], group_name='Crew')

    room = auth_client.get(reverse('room-list')).data['rooms'][0]

    # The whole dict, not just the name: ContactProfile.vue reads
    # `group_profile.tagline` with no undefined guard (getAvatarName and
    # getColor both fall back to ""), so a renamed key renders the literal
    # string "undefined" under Description. Renaming it left all 164 tests
    # green -- nothing pinned the shape.
    assert room['group_profile'] == {
        'id': None, 'username': 'Crew', 'tagline': ''}


def test_a_group_room_carries_its_own_name(auth_client, user, other):
    """The other half of the test above, on the line it cannot see.

    `get_group_name` answers the peer's username for a private chat and the
    room's own name for a group. Those are two statements. The test above pins
    `get_group_profile` -- which is built from `obj.group_name` *inside a dict*,
    a third statement. So replacing `get_group_name`'s group branch with `None`
    left `group_profile` correct and every one of the 259 green.

    What it costs is a crash, not a blank label. `User.vue:20` is
    `room.group_name.charAt(0).toUpperCase()` with no guard and no `||`, and
    one group member's row is enough to fail the render for everyone in the
    list. `MessagesSection.vue` writes the same field three times and guards it
    all three ways -- `? :` at :25, `|| ""` at :31 and :329 -- which is exactly
    why the reading of this file stopped at "the header has a fallback" and did
    not ask who else dereferences it.
    """
    create(auth_client, kind=GROUP, participants=[other.id], group_name='Crew')

    room = auth_client.get(reverse('room-list')).data['rooms'][0]

    assert room['group_name'] == 'Crew'


# ---------------------------------------------------------------- client/server cap

def test_the_group_name_cap_matches_the_model(settings):
    """`NewGroupModal.vue` hard-codes the same number, and jest cannot see
    this one.

    The frontend cannot import the model, so the cap lives in two places, and
    they drift silently in both directions: a client cap *above* the server's
    lets a name be typed that can never be submitted, and only a 400 field
    error says so; a cap *below* it quietly denies a name the server would
    have accepted.

    Read from the source rather than from the built bundle on purpose - the
    bundle is a build artifact that can be stale, and every frontend fix in
    this branch was a no-op until `npm run build` ran. Asserting the constant
    exists at all is the other half: `maxlength` bound to an undefined number
    renders as no attribute, which is exactly the defect.

    The mirror of `test_the_client_cap_matches_the_body_limit` in
    `chat/_tests/test_message_api.py`.
    """
    source = (
        Path(settings.BASE_DIR) / 'frontend' / 'src' / 'components' /
        'rooms' / 'NewGroupModal.vue'
    ).read_text(encoding='utf-8')

    match = re.search(r'maxGroupName:\s*(\d+)', source)
    assert match, 'NewGroupModal.vue declares no maxGroupName, so the name input has no cap'

    assert int(match.group(1)) == Room._meta.get_field('group_name').max_length


# --------------------------------------------------------- client/server seam

def _group_post(settings):
    """The path and body `createGroup` sends, read out of the source.

    Source, not the built bundle, for the reason the cap test above gives: the
    bundle is a build artifact that can be stale. Two returns because these are
    two contracts - where the POST goes and what is in it - and they are pinned
    separately so a change to one cannot quietly satisfy the other.
    """
    source = (
        Path(settings.BASE_DIR) / 'frontend' / 'src' / 'store' / 'actions.js'
    ).read_text(encoding='utf-8')

    match = re.search(r'post\("([^"]+)",\s*\{([^}]*)\}', source)
    assert match, 'no axios.post to a room endpoint with a literal body'
    return match.group(1), match.group(2)


def test_the_client_group_post_targets_the_room_list(settings):
    """`store/actions.js` builds this path by hand and jest cannot see the view.

    Everything else in `create`'s URL is interpolated from the id - there is no
    id for a room that does not exist yet, which is why this is the one path in
    the file with a literal in it, and therefore the one a copy-paste can get
    wrong.
    """
    path, _ = _group_post(settings)

    assert path == reverse('room-list')


def test_every_field_the_client_reads_is_still_produced(settings):
    """The half-rename, which is a defect -- as against the coordinated rename
    below, which is not. One test for all three payloads because it is one rule.

    Renaming a field on the server alone is *legal*: `group_profile`, `is_owner`
    and `tagline` are all `SerializerMethodField`s or explicit `fields` entries,
    so no model column has to agree. Each was measured by doing the rename and
    running both suites:

    | renamed                         | pytest | jest    | what breaks          |
    |---------------------------------|--------|---------|----------------------|
    | `group_profile` -> `group_rofile`| red   | 235 pass | group avatar blank   |
    | `is_owner` -> `is_ownr`          | red    | 235 pass | sent/received swapped|
    | `tagline` -> `taglne`            | red    | 235 pass | description blank    |

    All three left every one of the 235 jest tests green. jest is the suite that
    covers the rendering, and every fixture in it is hand-written -- nothing
    there has heard from the server. The pytest tests that go red are tests *of
    the serializer*: they report that the server changed, which is true, and
    that is not the same as reporting that the client is now wrong. Both halves
    of this were run, not reasoned.

    So this pins the one direction that is a defect: a field the frontend reads
    must still be one the serializer emits. Deliberately one-directional.
    Renaming both sides together is a correct change and has to stay green, which
    is what the next test pins by value rather than by name.

    Three payloads, three receivers, one comparison -- so adding a fourth is a
    line here rather than a thirteenth copy of this loop.
    """
    sources = [
        path.read_text(encoding='utf-8')
        for path in (Path(settings.BASE_DIR) / 'frontend' / 'src').rglob('*.vue')]

    # (serializer, receiver names the client holds that payload under, fields
    # that are ours and not the server's).
    seams = (
        (RoomSerializer, r'getRoom|currentRoom|room', set()),
        (MessageSerializer, r'message|lastMessage', {'sending'}),
        # One UserSerializer, three shapes of it: the logged-in profile, the
        # author of a message, and the `group_profile` a room carries. The
        # invitation payload is deliberately absent -- `FriendshipSentRequest
        # Serializer` nests a *different*, narrower UserSerializer, and pytest
        # already pins that one (measured: `to_user` -> `t_user`, 15 failed).
        (UserSerializer, r'getUserProfile|getGroupProfile|getUser|user', set()),
    )

    for serializer, receiver, client_only in seams:
        reads = set()
        for source in sources:
            # Not `(?<![\w.])`: `this.` is a preceding dot, and `invitation.to_user`
            # would match a bare `user\.` and attribute the invitation's field
            # to this payload. The dot is a receiver boundary, not a word char.
            reads |= set(re.findall(
                rf'(?:this\.)?(?:{receiver})\.([a-zA-Z_]+)', source))
        assert reads, (
            f'nothing matched for {serializer.__name__} -- the reader pattern '
            f'has gone stale, and this test is now vacuously green')

        missing = (reads - client_only) - set(serializer().fields)
        assert not missing, (
            f'the client reads {sorted(missing)} off a '
            f'{serializer.__name__} and it no longer sends it. jest cannot see '
            f'this: every fixture in it is hand-written, so nothing there has '
            f'heard from the server.')


def test_the_client_group_payload_matches_the_serializer(settings):
    """`Room.RoomKind` has nine copies of its own numbering and nothing compared
    two of them. This is the one that was not compared to anything.

    Renumbering GROUP consistently - the enum, `conftest`, `roomViews.create`'s
    branch and `test_consumer.py`'s three literals, all moved together, which is
    exactly what a careful developer does - leaves **226 pytest and 134 jest all
    green**. Meanwhile `createGroup` is still posting `kind: 2`, `2` is no longer
    in the model's `choices`, and every group created from the UI comes back
    400. Measured, not argued: the full coordinated mutation is this test's
    reversion, and it is the only thing in this repository that goes red.

    jest cannot catch it. `create_group.spec.js` asserts `kind: 2` against a
    literal it cannot see the serializer through, so both halves stayed green
    while disagreeing - which is item 42's shape exactly, and the reason the
    plan records that class as open for every response field and payload the
    client reads.

    Keys as well as the value. `CreateRoomSerializer.Meta.fields` is the whole
    accepted body, and a renamed field is a 400 the user cannot act on; the two
    silent properties are what this replaces - `kind` meaning "private" without
    anyone noticing, and a body key that does not exist being dropped rather
    than rejected.

    Read from the source, for the reason the cap test above gives.
    """
    _, body = _group_post(settings)

    keys = {re.split(r'[:\s]', part.strip())[0] for part in body.split(',')}
    assert keys == set(CreateRoomSerializer.Meta.fields), (
        'the client posts %r, the serializer accepts %r'
        % (sorted(keys), sorted(CreateRoomSerializer.Meta.fields)))

    kind = re.search(r'kind:\s*(\d+)', body)
    assert kind, 'the client sends no numeric kind, so `choices` has nothing to check'
    assert int(kind.group(1)) == Room.RoomKind.GROUP