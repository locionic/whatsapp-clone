"""Login and registration -- listed in the readme as shipped features, and
untested. Uses Django's test client rather than the DRF one: these are
session-auth views, not API endpoints.

The one_step backend is documented as "user signs up and is immediately
active and logged in", so no activation email is expected.
"""
from django.contrib.auth import get_user_model

User = get_user_model()

PASSWORD = 'sup3r-s3cret!'

GOOD_SIGNUP = {
    'username': 'newbie',
    'email': 'newbie@example.com',
    'password1': PASSWORD,
    'password2': PASSWORD,
}


def register_url():
    return '/accounts/register/'


def login_url():
    return '/accounts/login/'


# ------------------------------------------------------------------ register

def test_registration_form_renders(client, db):
    assert client.get(register_url()).status_code == 200


def test_registering_creates_an_active_user(client, db):
    client.post(register_url(), GOOD_SIGNUP)

    user = User.objects.get(username='newbie')
    assert user.email == 'newbie@example.com'
    assert user.is_active is True


def test_registering_logs_the_new_user_in(client, db):
    """one_step: "immediately active and logged in"."""
    client.post(register_url(), GOOD_SIGNUP)

    assert client.session.get('_auth_user_id') == str(
        User.objects.get(username='newbie').pk)


def test_a_new_user_can_log_in_afterwards(client, db):
    client.post(register_url(), GOOD_SIGNUP)
    client.logout()

    assert client.login(username='newbie', password=PASSWORD) is True


def test_password_is_hashed_not_stored(client, db):
    client.post(register_url(), GOOD_SIGNUP)

    user = User.objects.get(username='newbie')
    assert user.password != PASSWORD
    assert user.check_password(PASSWORD) is True


def test_cannot_register_a_duplicate_username(client, db):
    User.objects.create_user('newbie', 'taken@example.com', PASSWORD)

    response = client.post(register_url(), GOOD_SIGNUP)

    assert response.status_code == 200  # re-renders the form
    assert User.objects.filter(username='newbie').count() == 1


def test_mismatched_passwords_are_rejected(client, db):
    payload = dict(GOOD_SIGNUP, password2='something-else')

    client.post(register_url(), payload)

    assert not User.objects.filter(username='newbie').exists()


# --------------------------------------------------------------------- login

def test_login_form_renders(client, db):
    assert client.get(login_url()).status_code == 200


def test_logging_in_with_the_right_password(client, make_user):
    make_user('newbie', password=PASSWORD)

    response = client.post(login_url(), {'username': 'newbie', 'password': PASSWORD})

    assert response.status_code == 302
    assert client.session.get('_auth_user_id') is not None


def test_logging_in_with_a_wrong_password_stays_out(client, make_user):
    make_user('newbie', password=PASSWORD)

    client.post(login_url(), {'username': 'newbie', 'password': 'wrong'})

    assert client.session.get('_auth_user_id') is None
