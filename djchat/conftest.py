import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from chat.models import Message, Room

User = get_user_model()

PRIVATE = 1
GROUP = 2


@pytest.fixture(autouse=True)
def clear_cache():
    """The friends managers memoise in LocMemCache, which is process-global and
    survives the per-test DB rollback -- so pk N in one test is pk N in the next.
    Without this, a cached f-<pk> makes are_friends() report a stale True."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def make_user(db):
    """Factory so each test can name the users it needs."""
    def _make(username, **kwargs):
        kwargs.setdefault('password', 'pw')
        return User.objects.create_user(
            username=username,
            email=f'{username}@example.com',
            **kwargs)
    return _make


@pytest.fixture
def user(make_user):
    return make_user('alice')


@pytest.fixture
def other(make_user):
    return make_user('bob')


@pytest.fixture
def api_client():
    """DRF client; authenticate per-test with api_client.force_authenticate."""
    return APIClient()


@pytest.fixture
def auth_client(api_client, user):
    api_client.force_authenticate(user=user)
    return api_client


@pytest.fixture
def make_room(db):
    def _make(*participants, kind=PRIVATE, group_name=None):
        room = Room.objects.create(kind=kind, group_name=group_name)
        for participant in participants:
            room.participants.add(participant)
        return room
    return _make


@pytest.fixture
def make_message(db):
    def _make(room, author, body='', pending_read=(), pending_reception=()):
        message = Message.objects.create(room=room, author=author, body=body)
        # M2M cannot be passed to create(); Django >= 2.2 requires an explicit set().
        message.pending_read.set(pending_read)
        message.pending_reception.set(pending_reception)
        return message
    return _make