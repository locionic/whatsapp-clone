"""Profile rules, transcribed from the plan in `users/_tests/tests.py`."""
import re
from pathlib import Path

from django.urls import reverse

from users.api.serializers import UserSerializer
from users.models import CustomUser


def me_url():
    return reverse('current-user')


def test_returns_name_email_and_description(auth_client, user):
    user.tagline = 'hello there'
    user.save()

    data = auth_client.get(me_url()).data
    assert data['username'] == user.username
    assert data['email'] == user.email
    assert data['tagline'] == 'hello there'


def test_description_can_be_edited(auth_client, user):
    response = auth_client.patch(me_url(), {'tagline': 'new bio'}, format='json')

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.tagline == 'new bio'
    assert auth_client.get(me_url()).data['tagline'] == 'new bio'


def test_username_cannot_be_edited(auth_client, user):
    response = auth_client.patch(me_url(), {'username': 'mallory'}, format='json')

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.username == 'alice'


def test_email_cannot_be_edited(auth_client, user):
    response = auth_client.patch(me_url(), {'email': 'mallory@example.com'}, format='json')

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.email == 'alice@example.com'


def test_requires_authentication(api_client):
    assert api_client.get(me_url()).status_code in (401, 403)


def test_lookup_by_email_returns_the_user(api_client, user, make_user):
    carol = make_user('carol')
    api_client.force_authenticate(user=user)

    data = api_client.get('/api/v1/users', {'email': carol.email}).data
    assert data['id'] == carol.id
    assert data['username'] == 'carol'


def test_lookup_by_plus_addressed_email_returns_the_user(api_client, user, make_user):
    """The server half of what `getUserIdFromEmail` encodes its way into.

    A `+` in an address is a real, ordinary address form, and it is exactly the
    character a query string cannot carry unencoded -- `+` means space there, so
    `bob+chat@gmail.com` is read back as `bob chat@gmail.com` and matches
    nobody. The client now sends `bob%2Bchat%40gmail.com`; this pins that
    Django decodes that back to the address that was actually stored.

    The sibling tests above pass the address as a dict, which the test client
    encodes for us, so they cannot see this: they are the half that always
    worked. This one builds the encoded query string by hand, the way the
    browser does, and so covers the half that did not.
    """
    dave = make_user('dave')
    # Set after creating rather than through the factory: `make_user` passes
    # `email=` before `**kwargs`, so an `email=` argument collides with it.
    # Changing the shared fixture to reshape it for one caller is not worth it.
    dave.email = 'dave+chat@gmail.com'
    dave.save()
    api_client.force_authenticate(user=user)

    response = api_client.get('/api/v1/users?email=dave%2Bchat%40gmail.com')

    assert response.status_code == 200
    assert response.data['id'] == dave.id


def test_lookup_by_email_requires_authentication(api_client, make_user):
    """`?email=` resolves any address to an account, so it must stay behind the
    IsAuthenticated default rather than rely on the caller."""
    carol = make_user('carol')

    assert api_client.get('/api/v1/users', {'email': carol.email}).status_code \
        in (401, 403)


def test_lookup_by_email_does_not_hand_out_a_profile_bio(api_client, make_user):
    """The view serialized with the shared `UserSerializer`, which carries
    `tagline`. Any signed-in caller could name any address and read that
    stranger's free-text bio back -- an enumeration oracle, not a lookup.

    `id` and `username` stay: the invite flow needs the id, and the app already
    shows usernames to peers in group and participant profiles.
    """
    carol = make_user('carol')
    carol.tagline = 'phone number is 555-0134'
    carol.save()
    api_client.force_authenticate(user=make_user('mallory'))

    data = api_client.get('/api/v1/users', {'email': carol.email}).data

    assert 'tagline' not in data
    assert data['id'] == carol.id
    assert data['username'] == 'carol'


def test_your_own_profile_still_carries_your_tagline(api_client, make_user):
    """The bio has to move somewhere, not disappear: the contact profile is
    where you write it and where it is read."""
    mallory = make_user('mallory')
    mallory.tagline = 'phone number is 555-0134'
    mallory.save()
    api_client.force_authenticate(user=mallory)

    data = api_client.get(me_url()).data

    assert data['tagline'] == 'phone number is 555-0134'


def test_lookup_by_unknown_email_is_404(api_client, user):
    api_client.force_authenticate(user=user)
    assert api_client.get('/api/v1/users', {'email': 'nobody@example.com'}).status_code == 404


def test_lookup_without_an_email_is_rejected(api_client, user):
    """The view defaulted `email` to '', so a request with no `?email=` was a
    lookup for accounts with a blank address rather than a malformed request."""
    api_client.force_authenticate(user=user)

    assert api_client.get('/api/v1/users').status_code == 400


def test_lookup_with_a_blank_email_is_rejected(api_client, user):
    api_client.force_authenticate(user=user)

    assert api_client.get('/api/v1/users', {'email': ''}).status_code == 400


def test_a_blank_email_account_is_never_returned_by_a_bare_lookup(api_client, user):
    """Two blank addresses made the bare lookup ambiguous, and answering 200
    with one arbitrary account is worse than refusing."""
    CustomUser.objects.create_user(username='blank1', email='')
    CustomUser.objects.create_user(username='blank2', email='')
    api_client.force_authenticate(user=user)

    assert api_client.get('/api/v1/users').status_code == 400


def test_an_email_shared_by_two_accounts_is_rejected_not_a_crash(api_client, user):
    """Nothing enforces a unique email at the DB level -- only django_registration's
    form does, and createsuperuser2/UserAdmin do not go through it. get() over a
    non-unique field lets MultipleObjectsReturned escape as a 500."""
    CustomUser.objects.create_user(username='twin1', email='twin@example.com')
    CustomUser.objects.create_user(username='twin2', email='twin@example.com')
    api_client.force_authenticate(user=user)

    assert api_client.get(
        '/api/v1/users', {'email': 'twin@example.com'}).status_code == 400


# ------------------------------------------------------------- client/server seam

def _client_patch_keys(settings):
    """The keys `patchUserProfile` is handed, read out of the source.

    Not out of `actions.js`: `patchUserProfile` there takes the body as a
    `payload` argument and posts the variable, so the object literal is built by
    its one caller, in the component. That is also why this is not
    `test_the_client_cap_matches_the_body_limit`'s extraction - different file,
    different shape.
    """
    source = (
        Path(settings.BASE_DIR) / 'frontend' / 'src' / 'components' /
        'profiles' / 'UserProfile.vue'
    ).read_text(encoding='utf-8')

    match = re.search(r'dispatch\("patchUserProfile",\s*\{([^}]*)\}', source)
    assert match, ('UserProfile.vue hands patchUserProfile no object literal, so '
                   'this test is asserting nothing')
    keys = {re.split(r'[:\s]', part.strip())[0]
            for part in match.group(1).split(',') if part.strip()}
    assert keys, 'no key read out of the patchUserProfile payload'
    return keys


def test_the_client_patch_only_sends_fields_the_server_applies(settings):
    """The pin was on the wrong side of this seam, which is why it looked closed.

    `profile_save.spec.js` asserts
    `expect(dispatch).toHaveBeenCalledWith("patchUserProfile", {tagline: ...})` -
    a literal. Renaming the component's key to `bio` fails that spec and passes
    everything else, so the first mutation *is* caught. But the literal is
    pinned against itself: the client and its own test agree, and the serializer
    is a third party neither can see. Renaming it in both, which is exactly the
    "make these consistent" edit a careful developer makes, is:

        pytest 230 passed    jest 134 passed, 134 total, exit 0

    and the failure is silent end to end. `tagline` becomes a key DRF drops,
    `CustomUser.tagline` is `blank=True, default=''` so the PATCH 200s anyway,
    `patchUserProfile` resolves, and `UserProfile.patchUserProfile` runs
    `showSuccessAlert()`. The user is told their profile was saved and it was
    not - the same shape as item 54's dropped `body`, one field smaller.

    **Subset, not equality.** `Meta.fields` also holds `id`, `username` and
    `email`, which are `read_only`; demanding the client send those would assert
    the opposite of what `test_username_cannot_be_edited` and
    `test_email_cannot_be_edited` exist to pin. And a writable field the client
    cannot reach is a feature not built, not a defect, so equality would go red
    the day someone adds a column without a box for it. The claim worth making
    is the one the defect violates: **every key the client sends is one the
    server will actually apply.**

    Read from the source rather than the built bundle, for the reason
    `test_the_client_cap_matches_the_body_limit` gives.
    """
    writable = {name for name, field in UserSerializer().fields.items()
                if not field.read_only}
    sent = _client_patch_keys(settings)

    assert sent <= writable, (
        'UserProfile.vue sends %r; UserSerializer applies %r'
        % (sorted(sent), sorted(writable)))