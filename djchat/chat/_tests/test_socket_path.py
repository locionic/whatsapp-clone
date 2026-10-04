"""The socket endpoint is written down twice, in two languages, and nothing
tied the two copies to each other.

`App.vue` builds `scheme + window.location.host + "/ws/notifications/"` and
`chat/routing.py` serves `ws/notifications/$`. Each half is pinned to a literal
of its own -- `websocket_reconnect.spec.js` asserts the client's URL, and
`test_consumer.py` asserts the server's -- so a rename applied to one side only
is green in both runners:

    chat/routing.py -> ws/chat/,  test_consumer.py WS_URL -> /ws/chat/,
    App.vue untouched
        pytest  218 passed
        jest     97 passed

and the browser 404s its socket, `onclose` fires, and `reconnectWebSocket`
retries at 1s..30s for the rest of the session without a word. That retry loop
is items 2, 16 and 17 working as built; it is also what makes the failure
silent, since a socket that never connects looks exactly like a server that is
merely quiet.

The question asked here is the one a browser asks -- *can I get in at this
address* -- put to the real `djchat.asgi.application`, signed in. Not a regex
match: `AsyncConsumerRouter` resolves inside `__call__`, so a re-implemented
matcher would be a fourth copy of the pattern, and a copy is what this file
exists to delete. `test_consumer.py`'s only use of the full application asserts
a *refusal*, which an unroutable path also produces; this is the half that was
missing.
"""
import re

import pytest
from channels.testing import WebsocketCommunicator
from asgiref.sync import async_to_sync
from django.conf import settings
from django.contrib.auth import login as auth_login
from django.contrib.sessions.middleware import SessionMiddleware
from django.http import HttpResponse
from django.test import RequestFactory

from djchat.asgi import application

# The path half of the URL, anchored on the concatenation it is built from
# rather than on the literal -- the literal is the thing under test.
CONNECTED_PATH = re.compile(r'window\.location\.host\s*\+\s*[\'"]([^\'"]+)[\'"]')


def session_cookie_for(user):
    """A real session key, so `AuthMiddlewareStack` resolves `scope['user']`
    to this user rather than to `AnonymousUser` -- which is what makes the
    connection below a statement about routing instead of about auth."""
    request = RequestFactory().get('/')
    SessionMiddleware(lambda r: HttpResponse()).process_request(request)
    auth_login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    request.session.save()
    return request.session.session_key


def test_a_signed_in_browser_can_connect_to_the_path_app_vue_asks_for(user):
    app_vue = (settings.BASE_DIR / 'frontend' / 'src' / 'App.vue').read_text(
        encoding='utf-8')
    found = CONNECTED_PATH.search(app_vue)
    assert found, (
        'no `window.location.host + "..."` left in App.vue, so where the '
        'browser connects is somewhere this test can no longer see -- and an '
        'endpoint nothing can read the client side of cannot be checked '
        'against the router'
    )
    path = found.group(1)
    # Outside the coroutine: it writes a session row, and a sync ORM call from
    # inside an async context is a SynchronousOnlyOperation.
    key = session_cookie_for(user)

    async def scenario():
        comm = WebsocketCommunicator(application, path)
        comm.scope['headers'] = [(b'cookie', f'sessionid={key}'.encode())]
        try:
            connected = (await comm.connect())[0]
            if not connected and comm.future.done():
                # connect() reports only "no accept"; the reason is the
                # application's own exception, sitting on the future, and it
                # is the *next* input that re-raises it. Read it here, while
                # the message below can still explain it.
                comm.future.result()
            await comm.disconnect()
            return connected
        except ValueError as unrouted:
            pytest.fail(str(unrouted) + (
                f'\n\nApp.vue connects to {path!r} and djchat.asgi.application '
                f'serves something else. The browser would get that same '
                f'ValueError, its socket would close immediately, and '
                f'reconnectWebSocket would retry at 1s..30s for the rest of '
                f'the session without reporting anything. The two halves are '
                f'App.vue (frontend/src/App.vue) and chat/routing.py.'
            ))

    assert async_to_sync(scenario)() is True, (
        f'App.vue connects to {path!r} and a signed-in browser is refused there. '
        f'The socket would close immediately and reconnectWebSocket would retry '
        f'forever without reporting it.'
    )