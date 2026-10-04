"""`/chat/` used to serve the Channels tutorial page.

`chat/urls.py` routed `/chat/` to `views.room`, which rendered the page the
Channels tutorial ships: a bare `<textarea id="chat-log">`, a Send button, and
a WebSocket hardcoded to `ws://`. The Vue app replaced all of it and is served
from the catch-all entry point, so nothing in the tree links to `/chat/`.

Three things the page cost, all visible in the template:

* `ws://` is hardcoded and problems.txt starts this app as `daphne -e ssl:443`
  -- so the browser blocks it as mixed content and the socket never opens. Same
  hardcoded-scheme defect item 16 fixed in App.vue, in a file no frontend test
  could see.
* The Send button posts to a `ChatConsumer` that has no `receive` handler at
  all, so a typed message is accepted by the browser and silently discarded.
* The view carries no `LoginRequiredMixin`, so unlike every other page in the
  app it renders to an anonymous visitor.

`views.index` and `chat/index.html` were already unreachable: nothing routed to
`views.index`, only `views.room` was wired up.

Deleting the route hands `/chat/` to the catch-all, which is what already
serves every other unmatched URL -- so the path becomes an ordinary
client-side route into the SPA rather than a second, broken chat UI.
"""

import pytest


@pytest.mark.django_db
def test_an_anonymous_visitor_at_chat_is_sent_to_log_in(client, db):
    """The page used to render for anyone, signed in or not."""
    response = client.get('/chat/')

    assert response.status_code == 302
    assert response.headers['Location'].startswith('accounts/login/')


@pytest.mark.django_db
def test_the_chat_path_is_just_another_spa_url(client, user):
    """What `/chat/` is for now: nothing special, so nothing to keep for it.

    Byte-identical to `/` is the assertion that matters -- it says the path is
    handled by the ordinary entry point rather than by a view of its own, which
    is what makes the tutorial files redundant rather than merely unfashionable.
    """
    client.force_login(user)

    assert client.get('/chat/').content == client.get('/').content