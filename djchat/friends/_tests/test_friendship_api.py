"""Friendship-request API rules, transcribed from the "Creacion de invitacion"
block in `users/_tests/tests.py`. Model-level rules already live in
`friends/api/test.py`; these cover the HTTP surface."""
import pytest
from rest_framework.test import APIClient

from chat.models import Room
from friends.models import Friend, FriendshipRequest
from friends.signals import friendship_request_canceled


def add_url(user_id):
    return f'/api/v1/friends/add/{user_id}'


def accept_url(request_id):
    return f'/api/v1/friends/requests/accept/{request_id}'


def reject_url(request_id):
    return f'/api/v1/friends/requests/reject/{request_id}'


def cancel_url(request_id):
    return f'/api/v1/friends/requests/cancel/{request_id}'


def received_url():
    return '/api/v1/friends/requests/received'


def sent_url():
    return '/api/v1/friends/requests/sent'


def rejected_url():
    return '/api/v1/friends/requests/rejected'


def my_friends_url():
    return '/api/v1/friends'


def request_url(request_id):
    return f'/api/v1/friends/requests/{request_id}'


@pytest.fixture
def as_bob(other):
    """A second, *independent* client for cross-user authorization checks.

    Deliberately not built on `api_client`: force_authenticate mutates the
    client, so sharing one would let the last fixture win.
    """
    client = APIClient()
    client.force_authenticate(user=other)
    return client


# ----------------------------------------------------------------- creating one

def test_can_send_a_request(auth_client, user, other):
    response = auth_client.post(add_url(other.id))

    assert response.status_code == 200
    assert FriendshipRequest.objects.filter(from_user=user, to_user=other).count() == 1


def test_cannot_request_someone_who_is_already_a_friend(auth_client, user, other):
    Friend.objects.add_friend(user, other).accept()

    response = auth_client.post(add_url(other.id))

    assert response.status_code == 400
    assert FriendshipRequest.objects.count() == 0


def test_cannot_request_the_same_person_twice(auth_client, other):
    assert auth_client.post(add_url(other.id)).status_code == 200

    response = auth_client.post(add_url(other.id))

    assert response.status_code == 400
    assert FriendshipRequest.objects.count() == 1


def test_cannot_invite_yourself(auth_client, user):
    response = auth_client.post(add_url(user.id))

    assert response.status_code == 400
    assert FriendshipRequest.objects.count() == 0


def test_cannot_invite_a_user_that_does_not_exist(auth_client):
    assert auth_client.post(add_url(9999)).status_code == 404
    assert FriendshipRequest.objects.count() == 0


def test_invite_requires_authentication(api_client, other):
    assert api_client.post(add_url(other.id)).status_code in (401, 403)


# -------------------------------------------------------------------- accepting

def test_accepting_creates_the_friendship(auth_client, user, other):
    request = Friend.objects.add_friend(other, user)

    assert auth_client.post(accept_url(request.id)).status_code == 200

    assert Friend.objects.are_friends(user, other) is True
    assert FriendshipRequest.objects.count() == 0


def test_accepting_opens_a_private_room(auth_client, user, other):
    """chat.signals.friendship_request_accepted_callback creates the room."""
    request = Friend.objects.add_friend(other, user)

    auth_client.post(accept_url(request.id))

    room = Room.objects.get()
    assert room.kind == Room.RoomKind.PRIVATE
    assert set(room.participants.values_list('id', flat=True)) == {user.id, other.id}


def test_a_rejected_request_cannot_be_accepted(as_bob, user, other):
    """Rejecting keeps the row -- that is how the rejected list is built -- so
    the accept endpoint could find the receiver's own dismissal in
    friendship_requests_received and create the friendship anyway, with the
    sender never seeing their answer change."""
    request = Friend.objects.add_friend(user, other)
    request.reject()

    assert as_bob.post(accept_url(request.id)).status_code == 404

    assert Friend.objects.are_friends(user, other) is False
    assert Friend.objects.count() == 0


def test_a_rejected_request_keeps_its_row_for_the_rejected_list(
        as_bob, user, other):
    """The guard is a filter on the accept lookup, not a delete -- the
    receiver still needs the request id to show what they turned down."""
    request = Friend.objects.add_friend(user, other)

    as_bob.post(reject_url(request.id))

    assert [r['id'] for r in as_bob.get(rejected_url()).data] == [request.id]


def test_reinviting_after_a_removal_does_not_create_a_second_room(
        auth_client, user, other):
    """Removing a friend drops the friendship but leaves the room behind, so
    the accept signal has to dedupe exactly like RoomViewSet.create does."""
    Friend.objects.add_friend(other, user).accept()
    assert Room.objects.count() == 1

    auth_client.post(f'/api/v1/friends/remove/{other.id}')
    Friend.objects.add_friend(other, user)
    auth_client.post(accept_url(FriendshipRequest.objects.get().id))

    assert Room.objects.count() == 1


def test_accepting_never_lands_the_two_in_the_accepter_old_room(
        user, make_user, make_room):
    """The direction `test_reinviting_after_a_removal_does_not_create_a_second_room`
    cannot reach. That test needs *both* people to already share a room, so it
    never runs the case where the accepter has a private chat with somebody
    else -- which is the ordinary state of a user who has any friends at all.

    `get_or_create_private` chains two filters, and dropping the second turns
    "the one private room for these two people" into "a private room of this
    person's, with anyone in it". So Carol, who has been talking to Dave, accepts
    an invitation, and the room the signal hands back is her old one: the new
    friendship is created with no room joining the two of them, and Alice's
    sidebar never gains a conversation. `accept()` still reports 200 and still
    pushes `update_rooms` to both sides, so the failure is silent -- it is
    visible only as a room that never appears.

    Reverting that filter was green on all 257 tests: every accept test starts
    from users with no private room at all.
    """
    carol, dave = make_user('carol'), make_user('dave')
    carols_room = make_room(carol, dave)

    Friend.objects.add_friend(user, carol).accept()

    # Chained, not repeated, for the same reason the model chains them.
    shared = Room.objects.filter(participants=user).filter(participants=carol)
    assert shared.count() == 1
    assert shared.first().id != carols_room.id
    assert set(shared.first().participants.values_list('id', flat=True)) == {
        user.id, carol.id}
    # Her existing conversation is untouched -- the fix adds a room, it does not
    # move her.
    assert set(carols_room.participants.values_list('id', flat=True)) == {
        carol.id, dave.id}


def test_cannot_accept_a_request_addressed_to_someone_else(auth_client, as_bob, user, other):
    request = Friend.objects.add_friend(user, other)

    assert auth_client.post(accept_url(request.id)).status_code == 404


# -------------------------------------------------------------------- rejecting

def test_rejecting_keeps_them_apart(auth_client, user, other):
    request = Friend.objects.add_friend(other, user)

    assert auth_client.post(reject_url(request.id)).status_code == 200

    assert Friend.objects.are_friends(user, other) is False
    assert FriendshipRequest.objects.get(id=request.id).rejected is not None


def test_rejected_requests_are_listed_separately(auth_client, user, other):
    request = Friend.objects.add_friend(other, user)
    auth_client.post(reject_url(request.id))

    assert [r['id'] for r in auth_client.get(rejected_url()).data] == [request.id]


def test_each_refusal_carries_its_own_reason(auth_client, user, other):
    """The three 400s are distinguishable, so the client has something to show.

    All three are the same status, and the modal used to render the same
    sentence for all three -- so two of them told the user something that had
    not happened to them. The bodies are the contract this pins:

      already pending  -> "Friendship request already exists."
      already friends  -> "The users are already friends."
      yourself         -> ["Users cannot be friends with themselves"]

    The last one is a list: `ValidationError.messages` is a list of strings,
    while the two hand-built ones are bare strings. A client that assumes one
    shape silently renders nothing for the other.
    """
    pending = Friend.objects.add_friend(user, other)
    duplicate = auth_client.post(add_url(other.id))
    pending.accept()
    are_friends = auth_client.post(add_url(other.id))
    yourself = auth_client.post(add_url(user.id))

    assert duplicate.data['detail'] == 'Friendship request already exists.'
    assert are_friends.data['detail'] == 'The users are already friends.'
    assert yourself.data['detail'] == [
        'Users cannot be friends with themselves']
    # The trap the client fell into: all three are 400s.
    assert {duplicate.status_code, are_friends.status_code,
            yourself.status_code} == {400}


# --------------------------------------------- which tab does the body fill?

def assert_fills(tab, body):
    """The two list serializers are mirrors -- the sent one nests `to_user` and
    hides `from_user`, the received one the other way round -- and the store
    replaces a whole tab with the response, so this shape is the only thing in
    the body that says which tab it filled.
    """
    assert body, 'the tab came back empty, so the shape says nothing'
    expected, absent = ('to_user', 'from_user') if tab == 'sent' \
        else ('from_user', 'to_user')
    assert expected in body[0], f'expected the {tab} shape, got {sorted(body[0])}'
    assert absent not in body[0], f'expected the {tab} shape, got {sorted(body[0])}'


def test_adding_a_friend_answers_with_the_sent_tab(auth_client, user, other,
                                                   make_user):
    """`addFriend` commits the response to `SET_SENT_INVITATIONS`
    (`actions.js`), so the body has to be the *sent* list. Answering with the
    received one renders whatever the sender has received in their Sent tab --
    the invitation they just sent appears nowhere, and nothing errors.

    carol is here so the received list is not empty: a swap would then be
    answering with `[]`, which is right by accident and hides the swap.
    """
    carol = make_user('carol')
    Friend.objects.add_friend(carol, user)

    assert_fills('sent', auth_client.post(add_url(other.id)).data)


def test_accepting_answers_with_the_received_tab(auth_client, user, other,
                                                 make_user):
    """`acceptFriendRequest` commits to `SET_RECEIVED_INVITATIONS`, and this is
    the least guarded of the four: `accept()` deletes the row, so the accepted
    invitation is gone from both lists and the correct answer is a *shorter*
    list. carol keeps the received list non-empty and dave keeps the sent one
    non-empty, so a swap has something to be wrong about rather than returning
    an empty list either way.
    """
    carol, dave = make_user('carol'), make_user('dave')
    accepted = Friend.objects.add_friend(other, user)
    Friend.objects.add_friend(carol, user)
    Friend.objects.add_friend(user, dave)

    assert_fills('received', auth_client.post(accept_url(accepted.id)).data)


def test_rejecting_answers_with_the_received_tab(auth_client, user, other,
                                                 make_user):
    """`rejectFriendRequest` commits to `SET_RECEIVED_INVITATIONS`. Same two
    bystanders as the accept case, and for the same reason: the rejected row
    leaves the received list, so without carol the correct answer and the
    swapped one are both `[]`.
    """
    carol, dave = make_user('carol'), make_user('dave')
    rejected = Friend.objects.add_friend(other, user)
    Friend.objects.add_friend(carol, user)
    Friend.objects.add_friend(user, dave)

    assert_fills('received', auth_client.post(reject_url(rejected.id)).data)


def test_cancelling_answers_with_the_sent_tab(auth_client, user, other,
                                              make_user):
    """`cancelFriendRequest` commits to `SET_SENT_INVITATIONS`, and the sent
    tab is the one that shrinks here: replaced by the received list, the
    cancelled invitation reappears in Sent and the other one disappears.
    """
    carol, dave = make_user('carol'), make_user('dave')
    Friend.objects.add_friend(user, other)
    cancelled = Friend.objects.add_friend(user, dave)
    Friend.objects.add_friend(carol, user)

    assert_fills('sent', auth_client.post(cancel_url(cancelled.id)).data)


# -------------------------------------------------------------------- cancelling

def test_cancelling_removes_the_request(auth_client, user, other):
    request = Friend.objects.add_friend(user, other)

    assert auth_client.post(cancel_url(request.id)).status_code == 200

    assert FriendshipRequest.objects.count() == 0
    assert Friend.objects.are_friends(user, other) is False


def test_cancelling_reaches_both_tabs(user, other):
    """`cancel()` busts both tabs for the same reason `reject()` does, and the
    test above asserts `FriendshipRequest.objects.count() == 0` -- a direct
    query that never touches the cache, so both busts could be deleted and all
    252 tests stayed green.

    Warm the cache first; that is the entire point. An unwarmed cache makes a
    missing bust unobservable, because the list query misses the deleted row
    anyway. `test_rejecting_reaches_the_senders_list` says this in its own
    docstring for `reject()` -- this is item 47's bug in the other direction,
    found by mutation rather than by reading.
    """
    request = Friend.objects.add_friend(user, other)
    assert len(Friend.objects.sent_requests(user)) == 1
    assert len(Friend.objects.requests(other)) == 1

    request.cancel()

    assert Friend.objects.sent_requests(user) == []
    assert Friend.objects.requests(other) == []


def test_cannot_cancel_a_request_you_did_not_send(auth_client, user, other):
    request = Friend.objects.add_friend(other, user)

    assert auth_client.post(cancel_url(request.id)).status_code == 404


def test_cannot_cancel_a_request_they_already_rejected(
        auth_client, as_bob, user, other):
    """The other half of `test_a_rejected_request_cannot_be_accepted`.

    Rejecting keeps the row -- that is how the receiver's Rejected tab is
    built, and `add_friend` revives that same row when they ask again. But the
    cancel lookup reads `friendship_requests_sent` unfiltered, and that relation
    still holds a rejected row, so the sender can delete it: the receiver's
    record of what they turned down disappears from under them, on their next
    fetch, with a 200 and no push.

    The accept endpoint already guards this exact shape, and `sent_requests`
    already hides the row from the Sent tab, so there is no way to reach the
    button -- only the id, which the sender was given when they sent it.
    """
    request = Friend.objects.add_friend(user, other)
    as_bob.post(reject_url(request.id))
    assert [r['id'] for r in as_bob.get(rejected_url()).data] == [request.id]

    assert auth_client.post(cancel_url(request.id)).status_code == 404

    assert [r['id'] for r in as_bob.get(rejected_url()).data] == [request.id]


# ------------------------------------------------- looking a user up by id

def test_someone_elses_friend_list_is_not_reachable(auth_client, user, other):
    """The endpoint answered with any user's friends, emails included. It had
    no caller, so it was removed; /api/v1/friends still serves your own.

    Unmatched paths fall through to the SPA catch-all, which bounces to the
    login page -- hence 302 rather than 404."""
    Friend.objects.add_friend(user, other).accept()

    assert auth_client.get(f'/api/v1/friends/{other.id}').status_code in (302, 404)
    # and your own list is still served
    assert [u['id'] for u in auth_client.get(my_friends_url()).data] == [other.id]


# ------------------------------------------------------- cache invalidation

# Each of these warms the cache first: the manager memoises, so a missing
# bust_cache() only shows up when the same list is read before and after.

def test_rejecting_drops_the_request_from_the_unrejected_list(user, other):
    request = Friend.objects.add_friend(user, other)
    assert len(Friend.objects.unrejected_requests(other)) == 1

    request.reject()

    assert Friend.objects.unrejected_requests(other) == []


def test_a_rejected_request_shows_up_in_the_rejected_list(user, other):
    assert Friend.objects.rejected_requests(other) == []

    Friend.objects.add_friend(user, other).reject()

    assert len(Friend.objects.rejected_requests(other)) == 1


def test_rejecting_reaches_the_senders_list(user, other):
    """reject() used to bust only the receiver's caches, so the sender's sent
    list went on serving a pickled copy with rejected=None for the whole 300s
    cache TTL. The list filters on `rejected__isnull=True` now, so it is the
    stale warm cache that fails this -- busting is what empties it."""
    request = Friend.objects.add_friend(user, other)
    assert len(Friend.objects.sent_requests(user)) == 1

    request.reject()

    assert Friend.objects.sent_requests(user) == []


def test_viewing_a_request_clears_it_from_the_unread_count(user, other):
    request = Friend.objects.add_friend(user, other)
    assert Friend.objects.unread_request_count(other) == 1

    request.mark_viewed()

    assert Friend.objects.unread_request_count(other) == 0
    assert Friend.objects.unread_requests(other) == []


def test_a_viewed_request_shows_up_in_the_read_list(user, other):
    assert Friend.objects.read_requests(other) == []

    Friend.objects.add_friend(user, other).mark_viewed()

    assert len(Friend.objects.read_requests(other)) == 1


def test_cancel_signal_carries_the_users_not_tuples(user, other):
    """`from_user = self.from_user,` assigned a 1-tuple. It stayed invisible
    only because the sole receiver reads `to_user` and nothing else."""
    seen = {}

    def record(sender, **kwargs):
        seen.update(kwargs)

    friendship_request_canceled.connect(record, weak=False)
    try:
        Friend.objects.add_friend(user, other).cancel()
    finally:
        friendship_request_canceled.disconnect(record)

    assert seen['from_user'] == user
    assert seen['to_user'] == other


# -------------------------------------------------- the accepter's own Sent tab

class _RecordingChannelLayer:
    """Stands in for the channels layer so a push can be observed.

    `chat.signals` resolves its layer once at import time into a module global,
    so the patch has to target that name rather than the CHANNEL_LAYERS setting
    (which the InMemory layer in tests would keep serving anyway).
    """

    def __init__(self):
        self.sent = []

    async def group_send(self, group, message):
        self.sent.append((group, message))

    def groups_told_to(self, what):
        return {group for group, message in self.sent if message['message'] == what}


def test_the_accepter_is_told_to_refresh_their_sent_list(user, other, monkeypatch):
    """Both people invite each other, and the accepter's Sent tab goes stale.

    `can_request_send` only looks one way down, and `unique_together` is on the
    ordered pair, so the cross-invite is a legal state that any two users can
    reach from the UI.

    `accept()` then deletes the accepted row *and* its reverse, and busts both
    users' caches -- so both sent lists are already empty by the time the
    signal fires, and nothing needs fixing on the server side. Only the
    notification was missing: `friendship_request_accepted_callback` used to
    send `update_sent` to `from_user` and nothing else, and the accepter's own
    HTTP response carries the *received* list, not the sent one, so their Sent
    tab kept rendering a row that no longer exists, with a live Cancel button
    on it -- and Cancel 404s, because `accept()` is the thing that deleted it.
    That is the whole of the loop over `(from_user, to_user)`, and this is the
    only test that reads the accepter's half of it: item 86's reversion of that
    loop back to `(from_user,)` died here and nowhere else.
    """
    Friend.objects.add_friend(user, other)
    incoming = Friend.objects.add_friend(other, user)

    recorder = _RecordingChannelLayer()
    monkeypatch.setattr('chat.signals.channel_layer', recorder)

    incoming.accept()

    assert recorder.groups_told_to('update_sent') == {
        f'group_general_user_{user.id}',
        f'group_general_user_{other.id}',
    }


def test_both_sent_lists_are_already_empty_after_a_cross_invite_accept(user, other):
    """The control for the test above, and the reason it is a push defect and
    not a data one: the rows are gone and the caches are busted, so nothing
    needs fixing on the server side. Only the notification was missing. Without
    this, "fix" the test above by making `accept()` delete more.
    """
    Friend.objects.add_friend(user, other)
    incoming = Friend.objects.add_friend(other, user)

    incoming.accept()

    assert Friend.objects.sent_requests(user) == []
    assert Friend.objects.sent_requests(other) == []


# ---------------------------------------------------------------------- listing

def test_sent_and_received_are_separated(auth_client, user, other):
    incoming = Friend.objects.add_friend(other, user)
    outgoing = Friend.objects.add_friend(user, other)

    assert [r['id'] for r in auth_client.get(received_url()).data] == [incoming.id]
    assert [r['id'] for r in auth_client.get(sent_url()).data] == [outgoing.id]


def test_my_friends_lists_only_real_friends(auth_client, user, other, make_user):
    pending = make_user('carol')
    Friend.objects.add_friend(user, pending)
    Friend.objects.add_friend(user, other).accept()

    assert [u['id'] for u in auth_client.get(my_friends_url()).data] == [other.id]


def test_an_invitation_carries_the_other_user_in_full(auth_client, user, other):
    """UserInvitation.vue reads all three: `user.username.charAt(0)` for the
    avatar -- unguarded, so a missing username throws inside the render -- then
    the username itself and the email.

    This is friends/api/serializers.py's own UserSerializer, not the one in
    users/api/serializers.py that the users tests pin. Two classes, same name;
    dropping either field here left all 166 tests green.
    """
    Friend.objects.add_friend(other, user)
    Friend.objects.add_friend(user, other)

    received = auth_client.get(received_url()).data[0]
    sent = auth_client.get(sent_url()).data[0]

    assert received['from_user'] == {
        'id': other.id, 'username': other.username, 'email': other.email}
    assert sent['to_user'] == {
        'id': other.id, 'username': other.username, 'email': other.email}


# ----------------------------------------------------------- request detail

def test_cannot_read_a_request_you_are_not_a_party_to(auth_client, make_user):
    """The detail endpoint is scoped to both sides of the request, not just
    the recipient -- otherwise any user can enumerate who invited whom."""
    carol = make_user('carol')
    dave = make_user('dave')
    private_request = Friend.objects.add_friend(carol, dave)

    assert auth_client.get(request_url(private_request.id)).status_code == 404


def test_read_a_request_you_sent(auth_client, user, other):
    sent = Friend.objects.add_friend(user, other)

    assert auth_client.get(request_url(sent.id)).status_code == 200


def test_removed_friends_disappear(auth_client, user, other):
    Friend.objects.add_friend(user, other).accept()

    assert auth_client.post(f'/api/v1/friends/remove/{other.id}').status_code == 204

    assert Friend.objects.are_friends(user, other) is False
    assert auth_client.get(my_friends_url()).data == []


def test_removing_a_stranger_reports_not_found(auth_client, make_user):
    carol = make_user('carol')
    assert auth_client.post(f'/api/v1/friends/remove/{carol.id}').status_code == 404


def test_removing_a_user_that_does_not_exist_reports_not_found(auth_client):
    """`objects.get` used to raise DoesNotExist here, which DRF turns into a
    500. The sibling add endpoint already answers 404."""
    assert auth_client.post('/api/v1/friends/remove/9999').status_code == 404


# ----------------------------------------------------- rejected leaves the tabs

# The Sent and Received tabs render whatever they are handed, and
# UserInvitation.vue draws no state at all -- no rejected styling, no disabled
# button. A rejected invitation therefore came back looking live: a working
# Cancel button in Sent, a working accept button in Received, and a count
# against the Sent badge, for as long as the row existed. The row has to stay
# (rejected_requests is built from it, and add_friend reads it as a dismissal
# rather than a standing refusal), so the lists leave it out instead.


def test_a_pending_invitation_is_listed_on_both_sides(auth_client, as_bob, user, other):
    # The control: the filter is not just emptying both lists.
    request = Friend.objects.add_friend(user, other)

    assert [r['id'] for r in auth_client.get(sent_url()).data] == [request.id]
    assert [r['id'] for r in as_bob.get(received_url()).data] == [request.id]


def test_a_rejected_invitation_leaves_the_senders_list(auth_client, user, other):
    request = Friend.objects.add_friend(user, other)
    assert len(auth_client.get(sent_url()).data) == 1  # warms the cache

    request.reject()

    assert auth_client.get(sent_url()).data == []


def test_a_rejected_invitation_leaves_the_receivers_list(as_bob, user, other):
    request = Friend.objects.add_friend(user, other)
    assert len(as_bob.get(received_url()).data) == 1

    request.reject()

    assert as_bob.get(received_url()).data == []


def test_asking_again_after_a_rejection_puts_the_invitation_back(auth_client, user, other):
    """add_friend revives the same row by nulling `rejected`, so the new invite
    has to reappear. Without that, filtering rejected would make a second ask
    silently invisible -- which is the whole point of allowing one."""
    Friend.objects.add_friend(user, other).reject()
    assert auth_client.get(sent_url()).data == []

    request = Friend.objects.add_friend(user, other)

    assert [r['id'] for r in auth_client.get(sent_url()).data] == [request.id]


# ------------------------------------------------- the GET on a mutating URL

MUTATING_URLS = [accept_url, reject_url, cancel_url]


@pytest.mark.parametrize('url_for', MUTATING_URLS,
                         ids=['accept', 'reject', 'cancel'])
def test_a_get_on_a_mutating_url_returns_the_request_and_changes_nothing(
        auth_client, as_bob, user, other, url_for):
    """The only three statements in the app that no test executed.

    Measured, not read: running `coverage run -m pytest` over the tree left
    `friends/api/views.py` at `65, 86, 100` - one `get` per mutating view, each
    delegating to `FriendshipRequestDetailAPIView.get`. They are routed
    (`friends/api/urls.py:26-33`), so all three URLs answer GET *and* POST, and
    nothing in this repository - client or test - ever asks them to. The client
    only POSTs: `acceptFriendRequest`, `rejectFriendRequest` and
    `cancelFriendRequest` are the sole callers of the three URLs.

    So the pin is the safety property, not the payload: **a GET here must not
    accept, reject or cancel.** The URL says it does, a GET is what a link
    prefetcher, a crawler or a pasted address bar sends, and a 200 from
    `/accept/5` reads like an acceptance that never happened. The natural
    "cleanup" - deleting the `get` so the URL refuses GET - is fine; the
    dangerous one is making it mutate, and nothing here would notice.
    """
    request = Friend.objects.add_friend(user, other)

    response = auth_client.get(url_for(request.id))

    assert response.status_code == 200
    # The delegation: same body the dedicated detail URL serves.
    assert response.data == auth_client.get(request_url(request.id)).data
    # And nothing moved. A pending request is still pending, so the receiver's
    # list still holds it and `rejected` is still unset. The receiver's list is
    # `as_bob`'s to read: `add_friend(user, other)` sends it *to* other, and
    # `received_url()` answers for the caller's own inbox.
    assert Friend.objects.are_friends(user, other) is False
    assert request.rejected is None
    assert [r['id'] for r in as_bob.get(received_url()).data] == [request.id]


@pytest.mark.parametrize('url_for', MUTATING_URLS,
                         ids=['accept', 'reject', 'cancel'])
def test_a_get_on_a_mutating_url_will_not_show_you_someone_elses_request(
        auth_client, make_user, url_for):
    """The delegation inherits the detail view's ownership filter, and that is
    the only thing standing between these three URLs and an enumeration oracle:
    they take a request id in the path, and the ids are sequential.

    Same shape as `test_cannot_read_a_request_you_are_not_a_party_to`, and for
    the same reason - the request belongs to two *other* people, not to the
    caller. Using the receiver here would prove nothing: a 200 is correct for
    them.
    """
    carol = make_user('carol')
    dave = make_user('dave')
    private_request = Friend.objects.add_friend(carol, dave)

    assert auth_client.get(url_for(private_request.id)).status_code == 404