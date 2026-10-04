"""The socket's origin check, which had never been run.

Item 15 noticed that `asgi copy.py` was a draft from before
`AllowedHostsOriginValidator` was wrapped around the websocket, and item 42 found
that `djchat/routing.py` is imported by nothing. Neither one asked what the
validator *does*: it had never been exercised with an `Origin` header, so
nothing would have noticed if the next edit to `asgi.py` dropped it. It is a
one-token edit that turns the socket into one any page on the internet can open
with the visitor's cookies attached, and nothing in the suite goes red.

Measured, then pinned. The interesting part is the second test, and it is a
property of channels rather than of this project: **`AllowedHostsOriginValidator`
is a factory that reads `settings.ALLOWED_HOSTS` when it is called**, and
`asgi.py` calls it at import time. So `override_settings` cannot reach the
application under test - the hosts were frozen before the test started. The
stack has to be rebuilt to ask the question, which is why test 2 does that
rather than pretending a setting override reaches it.
"""
import pytest
from asgiref.sync import async_to_sync
from channels.auth import AuthMiddlewareStack
from channels.layers import get_channel_layer
from channels.routing import URLRouter
from channels.security.websocket import AllowedHostsOriginValidator
from channels.testing import WebsocketCommunicator

import chat.routing
from channels.security.websocket import OriginValidator
from django.conf import settings
from djchat.asgi import application

from chat._tests.test_socket_path import session_cookie_for

WS_URL = '/ws/notifications/'
ORIGIN_IN = 'http://testserver'
ORIGIN_OUT = 'http://evil.example.com'


def stack_with(allowed_hosts):
    """Rebuild what asgi.py builds, with a known ALLOWED_HOSTS."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr('django.conf.settings.ALLOWED_HOSTS', allowed_hosts)
        return AllowedHostsOriginValidator(
            AuthMiddlewareStack(URLRouter(chat.routing.websocket_urlpatterns)))


async def open_socket(target, key, origin):
    communicator = WebsocketCommunicator(
        target, WS_URL,
        headers=[(b'cookie', ('sessionid=%s' % key).encode()),
                 (b'origin', origin.encode())])
    return communicator, (await communicator.connect())[0]


def test_a_signed_in_browser_receives_its_own_notifications(user):
    """The whole chain, end to end: origin, auth, routing, group delivery.

    `test_socket_path.py` proves the browser can *connect* at this address.
    This proves that something arrives when it does - which is a different
    failure, and the one the app actually breaks on, because a socket that
    connects and then never delivers looks identical to a quiet server.
    """
    key = session_cookie_for(user)

    async def scenario():
        communicator, connected = await open_socket(
            application, key, ORIGIN_IN)
        assert connected, 'a signed-in browser was refused at the real stack'
        try:
            await get_channel_layer().group_send(
                'group_general_user_%s' % user.id,
                {'type': 'chat_message', 'message': 'hello', 'data': {}})
            return await communicator.receive_json_from()
        finally:
            await communicator.disconnect()

    assert async_to_sync(scenario)() == {'message': 'hello', 'data': {}}


def test_a_cross_origin_socket_is_refused_when_the_host_is_named(user):
    """The check itself - the reversion that kills this is unwrapping it.

    Both halves are needed. A test asserting only that cross-origin is refused
    passes just as well against a stack with no validator at all, because an
    unroutable or unauthenticated socket is refused too; asserting that
    same-origin still connects is what makes the refusal mean something.
    """
    key = session_cookie_for(user)
    strict = stack_with([ORIGIN_IN.split('//')[1]])

    async def scenario():
        _, crossed = await open_socket(strict, key, ORIGIN_OUT)
        _, own = await open_socket(strict, key, ORIGIN_IN)
        return crossed, own

    crossed, own = async_to_sync(scenario)()

    assert crossed is False, (
        "a socket opened from %s while serving %s - cross-site WebSocket "
        "hijacking: the victim's notifications are readable by that page"
        % (ORIGIN_OUT, ORIGIN_IN))
    assert own is True, (
        "the origin check refuses the app's own origin too, so the socket is "
        "broken rather than merely open - check ALLOWED_HOSTS")


def test_the_real_application_carries_the_origin_validator():
    """The shipped object, pinned by shape -- the only assertion that can.

    The two tests above build their own stack, so they measure channels and
    say nothing about *this* project's configuration. And behaviour cannot
    make the point either: `asgi.py` calls the factory at import time, when
    `ALLOWED_HOSTS` is still `'*'`, so the real application admits a
    cross-origin socket whether or not the wrapper is there. Deleting
    `AllowedHostsOriginValidator(` from `asgi.py` therefore fails **no** test
    in the file that looks behavioural.

    So the structure is asserted instead: the wrapper has to be present, and it
    has to hold the same host list the rest of the project sees. That is the
    edit nobody makes on purpose and everybody makes by accident.
    """
    websocket = application.application_mapping['websocket']

    assert isinstance(websocket, OriginValidator), (
        'the shipped websocket application is %s, not an OriginValidator -- '
        'AllowedHostsOriginValidator has been dropped from djchat/asgi.py'
        % type(websocket).__name__)
    # Subset, not equality, and the difference is the point: Django's test
    # setup appends 'testserver' to ALLOWED_HOSTS *after* djchat.asgi is
    # imported, so the validator froze `['*']` and settings now reads
    # `['*', 'testserver']`. Equality would fail here for a reason that has
    # nothing to do with the code under test. What must hold is that the frozen
    # list invents no host the project does not also allow.
    assert set(websocket.allowed_origins) <= set(settings.ALLOWED_HOSTS), (
        'the validator was built with %r, which settings does not allow (%r) -- '
        'it captured ALLOWED_HOSTS at import and is enforcing a stale list'
        % (websocket.allowed_origins, settings.ALLOWED_HOSTS))


def test_a_wildcard_allowed_host_turns_the_check_off(user):
    """The shipped default, recorded rather than discovered later.

    `ALLOWED_HOSTS` defaults to `'*'` unless `DJANGO_ALLOWED_HOSTS` is set, and
    channels treats `'*'` as "anything goes": with it in the list even a missing
    `Origin` header is allowed through. So the protection above is real but
    **dormant on a default deployment**. `deploy.sh` already makes
    `DJANGO_ALLOWED_HOSTS` a required deploy-time variable for exactly this
    reason; this test is the counterpart, so the day someone relaxes that
    requirement the socket's exposure is visible here.
    """
    key = session_cookie_for(user)
    wide = stack_with(['*'])

    async def scenario():
        _, crossed = await open_socket(wide, key, ORIGIN_OUT)
        return crossed

    assert async_to_sync(scenario)() is True, (
        'ALLOWED_HOSTS=["*"] no longer admits a cross-origin socket, so the '
        'note above is out of date and the deploy guidance needs revisiting')