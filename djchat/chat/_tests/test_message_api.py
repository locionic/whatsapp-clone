"""Message API rules, transcribed from the plan in `_tests/message_test.py`."""
import re
from datetime import timedelta
from pathlib import Path

import pytest
from django.urls import reverse
from django.utils import timezone

from chat.api.serializers import CreateMessageSerializer
from chat.models import Message


def pending_url():
    return reverse('message-list')


def room_messages_url(room_id):
    return f'/api/v1/messages/{room_id}'


def unread_url():
    return '/api/v1/messages/unread'


# ----------------------------------------------------------------- pending messages

def test_pending_messages_are_returned_then_consumed(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(room, other, 'hi', pending_reception=[user])

    first = auth_client.get(pending_url())
    assert first.status_code == 200
    assert [m['id'] for m in first.data['messages']] == [message.id]

    # The ack removed the user from pending, so it must not come back.
    second = auth_client.get(pending_url())
    assert second.data['messages'] == []

def test_every_pending_message_is_consumed_not_just_the_newest(
        auth_client, user, other, make_room, make_message):
    """The single-message case above is acked twice over, so it cannot tell
    the two ack paths apart. `MessageManager.get_pending_messages` clears the
    user from every pending message; `RoomSerializer.get_last_message` clears
    them from the *newest message in the room* and nothing else. With one
    pending message the two coincide, and deleting either call leaves the
    suite green.

    Here `older` is the room's newest, so the serializer would have cleaned it
    up anyway -- that is deliberate. The point is that the manager's own loop
    is what this test is exercising, and a second pending message in the same
    room is what makes the two paths distinguishable at all.
    """
    room = make_room(user, other)
    newest = make_message(room, other, 'newest', pending_reception=[user])
    older = make_message(room, other, 'older', pending_reception=[user])

    first = auth_client.get(pending_url())
    assert sorted(m['id'] for m in first.data['messages']) == sorted(
        [newest.id, older.id])

    # Both are gone, not just the one the serializer happened to touch.
    assert auth_client.get(pending_url()).data['messages'] == []


def test_message_not_pending_for_me_is_withheld(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, other, 'for someone else', pending_reception=[])
    assert auth_client.get(pending_url()).data['messages'] == []


def test_pending_response_carries_the_related_rooms_and_users(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, other, 'hi', pending_reception=[user])

    data = auth_client.get(pending_url()).data
    assert [r['id'] for r in data['rooms']] == [room.id]
    assert {u['id'] for u in data['users']} == {user.id, other.id}


def test_cannot_see_another_rooms_messages(
        auth_client, other, make_user, make_room, make_message):
    stranger = make_user('carol')
    room = make_room(other, stranger)
    make_message(room, stranger, 'private', pending_reception=[other])

    assert auth_client.get(room_messages_url(room.id)).status_code == 404


# ----------------------------------------------------------------------- create

def test_cannot_post_into_a_room_you_are_not_in(
        api_client, user, other, make_user, make_room):
    stranger = make_user('carol')
    room = make_room(other, stranger)
    api_client.force_authenticate(user=user)

    response = api_client.post(
        pending_url(),
        {'room': room.id, 'body': 'sneak', 'front_key': '3f1d9b77-6c2a-4e51-8d0f-77a1b2c3d4e5'})
    assert response.status_code == 403
    assert Message.objects.count() == 0


def test_created_message_becomes_unread_for_the_other_participant(
        auth_client, user, other, make_room):
    room = make_room(user, other)
    response = auth_client.post(
        pending_url(), {'room': room.id, 'body': 'hello', 'front_key': '8a1b0f14-3d1e-4a8f-9c2a-1b2c3d4e5f60'})

    assert response.status_code == 201
    message = Message.objects.get()
    assert list(message.pending_read.all()) == [other]
    assert list(message.pending_reception.all()) == [user, other]


def test_the_created_message_carries_the_clients_front_key(
        auth_client, user, other, make_room):
    """`front_key` is the only thing joining your bubble to the server's copy.

    The client writes the message into the thread the instant you press send,
    under a key it generated, and puts that key in `sendingPool` so the server's
    copy can take the clock icon off and be deduped against it
    (`LINK_MESSAGES_TO_ROOM`, `mergeMessages`, `REMOVE_FAILED_MESSAGE`).

    `front_key` is therefore the one field the client sends that the server has
    to *keep*. It is also the easiest to lose: `front_key = models.UUIDField(
    default=uuid.uuid4)` means a serializer that does not declare the field does
    not 400 on it, it silently falls back to a fresh random uuid. The client's
    own copy is then keyed by something the server never saw, so the server's
    copy arrives as a *second* message -- the thread shows it twice, still on
    its clock icon -- and a refused send removes a bubble that is not there.
    Dropping `front_key` from `CreateMessageSerializer.Meta.fields` was one of
    only two surviving mutations of eleven in the sweep this closes, at 98%
    statement coverage: every test in the suite posts a front_key, and every one
    of them only ever read the message back.
    """
    room = make_room(user, other)
    front_key = 'b7f4c1d2-9a63-4e58-8f0a-51d2e3c4b5a6'

    response = auth_client.post(
        pending_url(), {'room': room.id, 'body': 'hello', 'front_key': front_key})

    assert response.status_code == 201
    assert str(Message.objects.get().front_key) == front_key


def test_creating_a_message_updates_room_activity(auth_client, user, other, make_room):
    room = make_room(user, other)
    before = room.last_activity
    auth_client.post(
        pending_url(), {'room': room.id, 'body': 'hello', 'front_key': '9b2c1a25-4e2f-5b9a-ad3b-2c3d4e5f6071'})
    room.refresh_from_db()
    assert room.last_activity > before


# --------------------------------------------------------------- recent per room

def test_returns_the_ten_most_recent_in_ascending_order(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    created = [make_message(room, other, f'm{i}', pending_reception=[user]) for i in range(15)]

    data = auth_client.get(room_messages_url(room.id)).data
    ids = [m['id'] for m in data['messages']]
    assert ids == [m.id for m in created[5:]]


def test_offset_walks_backwards_through_history(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    created = [make_message(room, other, f'm{i}', pending_reception=[user]) for i in range(15)]

    oldest_returned = created[5]
    data = auth_client.get(f'{room_messages_url(room.id)}?offset={oldest_returned.id}').data
    ids = [m['id'] for m in data['messages']]
    assert ids == [m.id for m in created[:5]]


def test_a_non_numeric_offset_is_rejected_not_a_crash(
        auth_client, user, other, make_room, make_message):
    """The view did int() straight off the query string, so '?offset=abc'
    escaped as a 500 -- a one-query-string 500 on a read-only endpoint, for
    anyone who could reach the room.

    Also pins the neighbouring input, measured rather than assumed:
    '?offset=0' is a 200 that returns the newest page, because the branch is
    `if offset:` and 0 is falsy. Left as it is -- `offset` is `messages[0].id`
    or absent (`actions.js:56-57`), ids start at 1, so no client can send it,
    and the alternative (`id__lt=0`, an empty page) is the same empty answer.
    """
    room = make_room(user, other)
    make_message(room, other, 'hi', pending_reception=[user])

    assert auth_client.get(
        f'{room_messages_url(room.id)}?offset=abc').status_code == 400

    zero = auth_client.get(f'{room_messages_url(room.id)}?offset=0')
    assert zero.status_code == 200
    assert [m['body'] for m in zero.data['messages']] == ['hi']


def test_search_matches_the_body_and_not_just_the_newest(
        auth_client, user, other, make_room, make_message):
    """`?search=` is a substring match on the body.

    Case-insensitive because a search box is not case-sensitive to the person
    using it, and `icontains` is what makes that true on Postgres too, where
    LIKE is case-sensitive. Written as upper-lower-upper rather than one odd
    capital: a needle that differs from the text in one place only is easy to
    read as testing something else, and this one failed me once that way --
    `CAF?` does not contain "cafe", there is no `e` in it.
    """
    room = make_room(user, other)
    make_message(room, other, 'shall we meet at the cafe', pending_reception=[user])
    make_message(room, other, 'bringing the tickets', pending_reception=[user])
    make_message(room, other, 'MEET AT THE CAFE', pending_reception=[user])

    data = auth_client.get(
        f'{room_messages_url(room.id)}?search=cafe').data
    bodies = [m['body'] for m in data['messages']]

    assert bodies == ['shall we meet at the cafe', 'MEET AT THE CAFE']


def test_search_reaches_back_past_the_ten_the_room_opened_with(
        auth_client, user, other, make_room, make_message):
    """The reason this is a server query and not a filter over what is loaded.

    The room opens with the newest ten, so the store - and therefore anything
    the browser could search - holds ten messages out of the whole history.
    Pinned here so a client-side implementation cannot look correct while
    answering "no such message" for everything it never fetched.
    """
    room = make_room(user, other)
    needle = make_message(room, other, 'the answer is here',
                          pending_reception=[user])
    noise = [make_message(room, other, f'm{i}', pending_reception=[user])
             for i in range(30)]
    # `make_message` stamps `auto_now_add`, so every message above shares one
    # timestamp and "the newest ten" is decided by whatever order the database
    # happens to return ties in. Spread them out so the oldest is genuinely
    # oldest and this test measures the search rather than the tie-break.
    base = timezone.now() - timedelta(hours=1)
    for offset, message in enumerate([needle] + noise):
        Message.objects.filter(pk=message.pk).update(
            timestamp=base + timedelta(seconds=offset))

    room_opened = auth_client.get(room_messages_url(room.id)).data
    assert needle.id not in [m['id'] for m in room_opened['messages']]

    found = auth_client.get(
        f'{room_messages_url(room.id)}?search=answer').data
    assert [m['id'] for m in found['messages']] == [needle.id]


def test_search_narrows_the_result_rather_than_adding_to_it(
        auth_client, user, other, make_room, make_message):
    """A search returns matches, not matches-plus-the-newest-ten. `room.messages`
    is 15 messages deep here and only one contains the needle."""
    room = make_room(user, other)
    for i in range(15):
        make_message(room, other, f'noise {i}', pending_reception=[user])
    hit = make_message(room, other, 'needle', pending_reception=[user])

    data = auth_client.get(
        f'{room_messages_url(room.id)}?search=needle').data

    assert [m['id'] for m in data['messages']] == [hit.id]


def test_cannot_search_a_room_you_are_not_in(
        auth_client, other, make_room, make_message):
    """Search is a new way to ask for message *text*, so the membership gate is
    pinned against it rather than assumed to still apply. The 404 comes from the
    same `get_object_or_404(request.user.rooms.all())` the room fetch used, and
    that it happens before any filtering is the property worth holding."""
    room = make_room(other, other)
    make_message(room, other, 'a secret', pending_reception=[other])

    assert auth_client.get(
        f'{room_messages_url(room.id)}?search=secret').status_code == 404


# ------------------------------------------------------------- payload shape

def test_message_exposes_exactly_the_expected_fields(
        auth_client, user, other, make_room, make_message):
    """`que solo pueda ver los fields que se esperan, y no adicionales`.

    The delivery bookkeeping (`pending_reception` / `pending_read`) is internal
    state, not part of the wire format."""
    room = make_room(user, other)
    make_message(room, other, 'hi', pending_reception=[user])

    body = auth_client.get(room_messages_url(room.id)).data['messages'][0]

    assert set(body) == {
        'id', 'author', 'room', 'body', 'timestamp', 'front_key',
        'is_owner', 'all_received', 'all_read',
    }


def test_recent_per_room_returns_its_room_and_the_message_authors(
        auth_client, user, other, make_user, make_room, make_message):
    """`verificar que efectivamente vengan users y rooms correctos`"""
    carol = make_user('carol')
    room = make_room(user, other, carol)
    make_message(room, other, 'from bob', pending_reception=[user])
    make_message(room, carol, 'from carol', pending_reception=[user])

    data = auth_client.get(room_messages_url(room.id)).data

    assert data['room']['id'] == room.id
    assert {u['id'] for u in data['users']} == {other.id, carol.id}


def test_recent_response_flags_the_author_as_owner(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    mine = make_message(room, user, 'mine', pending_reception=[user])
    theirs = make_message(room, other, 'theirs', pending_reception=[user])

    by_id = {m['id']: m for m in auth_client.get(room_messages_url(room.id)).data['messages']}
    assert by_id[mine.id]['is_owner'] is True
    assert by_id[theirs.id]['is_owner'] is False


# ------------------------------------------------------------------ read / unread

def test_message_starts_unread_and_disappears_once_read(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(room, other, 'hi', pending_read=[user, other])

    listed = auth_client.get(unread_url())
    assert [m['id'] for m in listed.data['messages']] == [message.id]

    marked = auth_client.post(f'{unread_url()}?message_id={message.id}')
    assert marked.status_code == 204
    assert auth_client.get(unread_url()).data['messages'] == []


def test_cannot_mark_someone_elses_message_as_read(
        auth_client, other, make_user, make_room, make_message):
    stranger = make_user('carol')
    room = make_room(other, stranger)
    message = make_message(room, other, 'mine', pending_read=[stranger])

    auth_client.post(f'{unread_url()}?message_id={message.id}')
    assert list(message.pending_read.all()) == [stranger]


def test_marking_read_is_idempotent_for_bad_input(auth_client):
    # the endpoint answers 204 by contract even when there is nothing to mark
    assert auth_client.post(unread_url()).status_code == 204
    assert auth_client.post(f'{unread_url()}?message_id=not-an-int').status_code == 204
    assert auth_client.post(f'{unread_url()}?message_id=9999').status_code == 204


def test_unread_items_name_the_room_they_belong_to(
        auth_client, user, other, make_room, make_message):
    """`ADD_UNREAD_MESSAGES` stores `element.room` keyed by `element.id`, and
    User.vue draws the badge by filtering those values against `room.id`. Drop
    `room` and every badge in the app silently disappears -- no error, the
    unread counts just never appear. Nothing pinned the shape."""
    room = make_room(user, other)
    message = make_message(room, other, 'hi', pending_read=[user])

    body = auth_client.get(unread_url()).data['messages'][0]

    assert body == {'id': message.id, 'room': room.id}


def test_unread_spans_every_room_the_user_is_in(
        auth_client, user, other, make_user, make_room, make_message):
    carol = make_user('carol')
    first = make_room(user, other)
    second = make_room(user, other, carol)
    make_message(first, other, 'one', pending_read=[user])
    make_message(second, carol, 'two', pending_read=[user])

    assert len(auth_client.get(unread_url()).data['messages']) == 2


# ------------------------------------------------------- all received / all read

def test_viewing_a_room_acks_receipt_but_not_read(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    message = make_message(
        room, other, 'hi', pending_reception=[user], pending_read=[other])

    body = auth_client.get(room_messages_url(room.id)).data['messages'][0]
    assert body['body'] == 'hi'
    assert body['all_read'] is False
    # fetching the room is the receipt ack; reading is a separate explicit call
    message.refresh_from_db()
    assert not message.pending_reception.exists()
    assert list(message.pending_read.all()) == [other]


def test_flags_flip_once_everyone_has_received_and_read(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, other, 'hi', pending_reception=[], pending_read=[])

    body = auth_client.get(room_messages_url(room.id)).data['messages'][0]
    assert body['all_received'] is True
    assert body['all_read'] is True


def test_a_message_someone_is_still_pending_for_does_not_claim_all_received(
        auth_client, user, other, make_room, make_message):
    """The other half of the flag test above, and the half that was missing:
    that one only ever asserted the True case, so a serializer returning True
    unconditionally passed the entire suite. `all_received` is what `User.vue`
    draws the double tick from.

    `other` is pending and `user` is not, which is the shape that reaches it:
    `get_pending_messages` and `get_last_message` both ack *the requesting
    user* only, so nothing here quietly clears the flag before it is read.
    `/messages/` cannot express this -- it returns what is pending for you,
    and acking it is the call that returns it.
    """
    room = make_room(user, other)
    make_message(room, other, 'hi', pending_reception=[other],
                 pending_read=[other])

    body = auth_client.get(room_messages_url(room.id)).data['messages'][0]
    assert body['all_received'] is False
    assert body['all_read'] is False


# ------------------------------------------------------------------ the length cap

def test_a_body_at_the_limit_is_accepted_and_one_over_is_refused(
        auth_client, user, other, make_room):
    """The boundary the client's `maxlength` is copied from.

    `TextField(max_length=500)` is not enforced by the database -- `max_length`
    on a TextField is a no-op there -- but DRF's `get_field_kwargs` copies it
    onto the serializer field, so this 500/501 split is the whole of what the
    server enforces. Everything about a message's length is decided by it.
    """
    room = make_room(user, other)
    limit = Message._meta.get_field('body').max_length

    at_limit = auth_client.post(
        pending_url(), {'room': room.id, 'body': 'x' * limit},
        content_type='application/json')
    assert at_limit.status_code == 201

    over_limit = auth_client.post(
        pending_url(), {'room': room.id, 'body': 'x' * (limit + 1)},
        content_type='application/json')
    assert over_limit.status_code == 400


def test_the_client_cap_matches_the_body_limit(settings):
    """`SendForm.vue` hard-codes the same number, and jest cannot see this one.

    The frontend cannot import the model, so the cap lives in two places. They
    drift silently and in both directions: a client cap *above* the server's
    reproduces the defect this item fixes -- a message that is fully typable
    and can never be sent -- and only the 400 says so. A client cap *below* it
    quietly denies the user room the server would have accepted.

    Read from the source rather than from the built bundle on purpose. The
    bundle is a build artifact that can be stale (every frontend fix in this
    branch was a no-op until `npm run build` ran), so asserting against it
    would pass against a `dist/` that has not been rebuilt. Asserting the
    constant exists at all is the other half: `maxlength` bound to an undefined
    number renders as no attribute, which is exactly the defect.
    """
    source = (
        Path(settings.BASE_DIR) / 'frontend' / 'src' / 'components' /
        'SendForm.vue'
    ).read_text(encoding='utf-8')

    match = re.search(r'maxBody:\s*(\d+)', source)
    assert match, 'SendForm.vue declares no maxBody, so the input has no cap'

    assert int(match.group(1)) == Message._meta.get_field('body').max_length


# ------------------------------------------------------------- client/server seam

def _client_send_keys(settings):
    """The keys `sendMessage` can put in a request body, read out of the source.

    Two shapes, because the payload is built in two: the always-sent keys are
    shorthand (`room,`) and `front_key` arrives through a conditional spread, so
    a message sent without one carries two keys and a message sent with one
    carries three. A single regex over `post(..., {...})` cannot see either --
    `sendMessage` assigns the literal to `payload` first, which is also why
    item 52's group-post regex stops at `createGroup`.
    """
    source = (
        Path(settings.BASE_DIR) / 'frontend' / 'src' / 'store' / 'actions.js'
    ).read_text(encoding='utf-8')

    block = re.search(r'let payload = \{(.*?)\n    \};', source, re.S)
    assert block, ('sendMessage builds no `payload` literal, so this test is '
                   'asserting nothing')
    body = block.group(1)

    keys = set(re.findall(r'^\s*(\w+),', body, re.M))     # room, body
    keys |= set(re.findall(r'\{ (\w+) \}', body))          # front_key
    assert keys, 'no key read out of the sendMessage payload'
    return keys


def test_the_client_send_payload_matches_the_serializer(settings):
    """The mirror of `test_the_client_group_payload_matches_the_serializer`, and
    the same class: a contract each half kept to itself.

    `sendMessage` names its three keys; `CreateMessageSerializer` names the same
    three; nothing compared them. Two of the three mutations produce a 201 with
    no error anywhere, which is what makes this worth pinning over a 400:

      - `room` -> `roomId` is the loud one. `room` is required, so the request
        400s and `REMOVE_FAILED_MESSAGE` pulls the optimistic bubble back.
      - `body` -> `text` is the bad one. `body` is *not* required -- the model
        defaults it to `''` -- so the request succeeds, stores an empty message
        and broadcasts it to every participant, and the text the user typed
        exists only in the bubble that never leaves their screen. Measured off
        the serializer: `{'room': True, 'body': False, 'front_key': False}`.
      - `front_key` -> `clientKey` also succeeds, with the model's `uuid4`
        default. `front_key` is the only thing joining your bubble to the
        server's copy, so the two never match and `sending: true` is never
        cleared. The other half of that same defect --
        `test_the_created_message_carries_the_clients_front_key` -- pins the key
        on the *serializer* side, and cannot see the client stop sending it.

    Measured, before this test existed: each mutation in turn, the whole suite,
    pytest `229 passed` and jest `134 passed, 134 total` with exit 0. jest
    imports `store/actions` in three specs and none of them looks at this
    payload -- `send_form_maxlength.spec.js` asserts the cap and
    `create_group.spec.js` the group post.

    Read from the source rather than the built bundle, for the reason the cap
    test above gives.
    """
    assert _client_send_keys(settings) == set(CreateMessageSerializer.Meta.fields), (
        'sendMessage posts %r, the serializer accepts %r'
        % (sorted(_client_send_keys(settings)),
           sorted(CreateMessageSerializer.Meta.fields)))