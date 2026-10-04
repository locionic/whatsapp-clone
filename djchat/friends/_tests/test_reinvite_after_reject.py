"""Re-inviting someone who rejected you.

A rejection is a soft dismissal -- Block is the ban -- but reject() keeps the
row (the receiver's "rejected" list is built from it).  add_friend used to
refuse on any matching row, so it answered "Friendship request already
exists" for a request that no longer existed and never would again.
"""


def invite(api_client, from_user, to_user):
    api_client.force_authenticate(user=from_user)
    return api_client.post(f'/api/v1/friends/add/{to_user.pk}')


def reject(api_client, recipient, request_id):
    api_client.force_authenticate(user=recipient)
    return api_client.post(f'/api/v1/friends/requests/reject/{request_id}')


def received(api_client, recipient):
    api_client.force_authenticate(user=recipient)
    return api_client.get('/api/v1/friends/requests/received').data


def sent(api_client, sender):
    api_client.force_authenticate(user=sender)
    return api_client.get('/api/v1/friends/requests/sent').data


def test_reinviting_after_a_rejection_is_allowed(api_client, user, other):
    assert invite(api_client, user, other).status_code == 200

    reject(api_client, other, received(api_client, other)[0]['id'])

    assert invite(api_client, user, other).status_code == 200


def test_the_revived_request_is_pending_not_rejected(api_client, user, other):
    invite(api_client, user, other)
    reject(api_client, other, received(api_client, other)[0]['id'])

    invite(api_client, user, other)

    invitation = sent(api_client, user)[0]
    assert invitation['rejected'] is None
    assert invitation['viewed'] is None


def test_the_receiver_sees_it_again_as_a_fresh_invitation(
        api_client, user, other):
    invite(api_client, user, other)
    reject(api_client, other, received(api_client, other)[0]['id'])

    invite(api_client, user, other)

    # The frontend hides rejected rows; this one has to come back unhidden.
    assert received(api_client, other)[0]['rejected'] is None


def test_the_revived_request_can_actually_be_accepted(
        api_client, user, other):
    invite(api_client, user, other)
    reject(api_client, other, received(api_client, other)[0]['id'])
    invite(api_client, user, other)

    request_id = received(api_client, other)[0]['id']
    api_client.force_authenticate(user=other)
    response = api_client.post(f'/api/v1/friends/requests/accept/{request_id}')

    assert response.status_code == 200
    api_client.force_authenticate(user=user)
    assert [u['id'] for u in api_client.get('/api/v1/friends').data] == \
        [other.pk]


def test_the_rejected_list_drops_the_request_once_it_is_reinvited(
        api_client, user, other):
    """The receiver's dismissed list must clear, or it keeps showing an
    invitation that is pending again."""
    invite(api_client, user, other)
    reject(api_client, other, received(api_client, other)[0]['id'])
    api_client.force_authenticate(user=other)
    assert len(api_client.get('/api/v1/friends/requests/rejected').data) == 1

    invite(api_client, user, other)
    api_client.force_authenticate(user=other)

    assert api_client.get('/api/v1/friends/requests/rejected').data == []


def test_a_second_invitation_while_one_is_pending_is_still_refused(
        api_client, user, other):
    """The guard the revival had to be careful not to weaken."""
    assert invite(api_client, user, other).status_code == 200

    assert invite(api_client, user, other).status_code == 400


def test_a_reinvitation_comes_back_unread(user, other):
    """The receiver had already read the first one before dismissing it.

    Reviving the row without clearing `viewed` leaves it in the read list, so
    the client shows a fresh arrival as already-handled.
    """
    from friends.models import Friend

    request = Friend.objects.add_friend(user, other)
    request.mark_viewed()
    request.reject()
    assert request.viewed is not None

    revived = Friend.objects.add_friend(user, other)

    assert revived.pk == request.pk
    assert revived.viewed is None


def test_can_request_send_ignores_a_rejected_row(user, other):
    from friends.models import Friend

    request = Friend.objects.add_friend(user, other)
    request.reject()

    assert Friend.objects.can_request_send(user, other) is False
