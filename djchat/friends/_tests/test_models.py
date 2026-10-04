"""What `friends/models.py` shows, and the one branch it never took.

Two things the other friends tests do not reach, both found by measuring rather
than guessing: `coverage run -m pytest` puts this module at 96.7% and the eleven
missing lines are four `__str__` methods, one `return True` in `are_friends`, an
unreachable `except`, and four lines on the Follow/Block axis that has no caller
and no route. This file covers the first five. The other six are recorded in
PLAN.md item 80 as measured negatives.
"""
import pytest
from django.core.cache import cache

from friends.models import (
    Block,
    Follow,
    Friend,
    FriendshipRequest,
    cache_key,
)


def test_every_relationship_names_both_sides_of_itself():
    """All four of these are registered in `admin.py:26-29`, so `__str__` is the
    changelist column and the everywhere dropdown label -- a row is identified
    by this string and nothing else.

    Three of the four already do it. `FriendshipRequest` did not: it returned
    `"%s" % self.from_user_id`, so the admin listed every pending request as a
    bare sender id, and two requests from the same person were indistinguishable
    from each other in the column you pick a request from.
    """
    pairs = [
        (FriendshipRequest(from_user_id=3, to_user_id=7), 3, 7),
        (Friend(from_user_id=3, to_user_id=7), 3, 7),
        (Follow(follower_id=3, followee_id=7), 3, 7),
        (Block(blocker_id=3, blocked_id=7), 3, 7),
    ]

    for instance, first, second in pairs:
        shown = str(instance)
        assert str(first) in shown and str(second) in shown, (
            "%s shows %r, which does not name both sides"
            % (type(instance).__name__, shown)
        )


@pytest.mark.django_db
def test_are_friends_answers_from_either_users_cache(user, other):
    """`are_friends` consults two cache keys before it touches the database --
    `f-<user1.pk>` and `f-<user2.pk>` -- and the second branch was the one line
    in the module no test had reached.

    Both branches return the same thing, so this is not a claim about a
    different answer. It is that the second key is consulted at all: primed
    only on `other`'s side, with `user`'s key left unset and no `Friend` row in
    the database, a reversion that dropped that lookup would fall through to the
    `DoesNotExist` below and answer False -- which `add_friend` reads as "not
    friends yet", so it would open a second friendship request between two
    people who are already friends.

    The cached values are `User` objects rather than pks, because that is what
    `FriendshipManager.friends` stores (`models.py:199-200`) and `in` compares
    models by pk.
    """
    cache.set(cache_key("friends", other.pk), [user])

    assert Friend.objects.are_friends(user, other) is True
    assert Friend.objects.are_friends(other, user) is True