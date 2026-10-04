"""Follow/Block manager rules. These four methods raised NameError before
the missing signals were defined."""
import pytest
from django.core.cache import cache
from django.core.exceptions import ValidationError

from friends.exceptions import AlreadyExistsError
from friends.models import Block, Follow


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()
    yield
    cache.clear()


# ------------------------------------------------------------------------ follow

def test_add_follower_creates_the_relation(user, other):
    assert Follow.objects.follows(user, other) is False

    relation = Follow.objects.add_follower(user, other)

    assert isinstance(relation, Follow)
    assert list(Follow.objects.following(user)) == [other]
    assert list(Follow.objects.followers(other)) == [user]
    assert Follow.objects.follows(user, other) is True


def test_cannot_follow_twice(user, other):
    Follow.objects.add_follower(user, other)
    with pytest.raises(AlreadyExistsError):
        Follow.objects.add_follower(user, other)


def test_cannot_follow_yourself(user):
    with pytest.raises(ValidationError):
        Follow.objects.add_follower(user, user)


def test_remove_follower(user, other):
    Follow.objects.add_follower(user, other)

    assert Follow.objects.remove_follower(user, other) is True
    assert Follow.objects.follows(user, other) is False
    # removing again reports that there was nothing to remove
    assert Follow.objects.remove_follower(user, other) is False


def test_following_is_directional(user, other):
    Follow.objects.add_follower(user, other)

    assert Follow.objects.follows(user, other) is True
    assert Follow.objects.follows(other, user) is False


# ------------------------------------------------------------------------- block

def test_add_block_creates_the_relation(user, other):
    assert Block.objects.is_blocked(user, other) is False

    relation = Block.objects.add_block(user, other)

    assert isinstance(relation, Block)
    assert Block.objects.is_blocked(user, other) is True
    assert list(Block.objects.blocked(other)) == [user]
    assert list(Block.objects.blocking(user)) == [other]


def test_cannot_block_twice(user, other):
    Block.objects.add_block(user, other)
    with pytest.raises(AlreadyExistsError):
        Block.objects.add_block(user, other)


def test_cannot_block_yourself(user):
    with pytest.raises(ValidationError):
        Block.objects.add_block(user, user)


def test_remove_block_returns_false_instead_of_raising(user, other):
    # caught the wrong exception (Follow.DoesNotExist) and used the wrong
    # signal name for the blocking-removed notification
    assert Block.objects.remove_block(user, other) is False

    Block.objects.add_block(user, other)
    assert Block.objects.remove_block(user, other) is True
    assert Block.objects.is_blocked(user, other) is False


def test_blocking_is_directional(user, other):
    Block.objects.add_block(user, other)

    assert Block.objects.is_blocked(user, other) is True
    assert Block.objects.is_blocked(other, user) is False


def test_is_blocked_serves_from_the_warmed_cache(user, other):
    """White-box: deleting the row behind the cache's back proves the answer
    came from the cache rather than a fallback query. is_blocked used to read
    the `blocks` prefix, which nothing ever writes, so both reads missed."""
    Block.objects.add_block(user, other)
    Block.objects.blocking(user)
    Block.objects.filter(blocker=user, blocked=other).delete()

    assert Block.objects.is_blocked(user, other) is True


@pytest.mark.parametrize('method,expected', [
    ('add_follower', ['follower_created', 'followee_created', 'following_created']),
    ('remove_follower', ['follower_removed', 'followee_removed', 'following_removed']),
])
def test_follow_signals_fire_once_each(user, other, monkeypatch, method, expected):
    sends = _record_sends(monkeypatch, [
        'follower_created', 'follower_removed', 'followee_created',
        'followee_removed', 'following_created', 'following_removed'])
    if method == 'add_follower':
        Follow.objects.add_follower(user, other)
    else:
        Follow.objects.add_follower(user, other)
        sends.clear()
        Follow.objects.remove_follower(user, other)

    assert sends == expected


def test_block_signals_fire_once_each(user, other, monkeypatch):
    sends = _record_sends(monkeypatch, [
        'block_created', 'block_removed', 'blocking_created', 'blocking_removed'])

    Block.objects.add_block(user, other)
    assert sends == ['block_created', 'block_created', 'blocking_created']
    # both block_removed kwargs (blocker/blocked) plus blocking_removed,
    # rather than three sends of the same signal
    assert sends.count('block_created') == 2

    sends.clear()
    Block.objects.remove_block(user, other)
    assert sends == ['block_removed', 'block_removed', 'blocking_removed']


def _record_sends(monkeypatch, names):
    """Swap each signal's send() for a recorder; returns the call log.

    Patch `friends.models`, not `friends.signals`: models.py does
    `from friends.signals import block_created`, so the name is already bound
    in its own namespace by the time anything calls it.
    """
    from friends import models as friends_models

    sends = []
    for name in names:
        def _send(_name=name, **kwargs):
            sends.append(_name)
            return []
        monkeypatch.setattr(
            friends_models, name, type(name, (), {'send': staticmethod(_send)}))
    return sends