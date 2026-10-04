"""The SPA entry point.

re_path(r"^.*$", IndexTemplateView.as_view()) is last in the urlpatterns, so
every URL Django has not otherwise claimed lands here -- it is the app's front
door, and the thing that has to carry client-side routing.
"""

import re
from pathlib import Path

import pytest

from django.conf import settings
from django.contrib.staticfiles import finders
from django.test import override_settings


@pytest.mark.django_db
def test_a_signed_in_user_gets_the_spa_shell(client, user):
    client.force_login(user)

    response = client.get('/')

    assert response.status_code == 200
    assert b'<div id="app">' in response.content


@pytest.mark.django_db
def test_an_anonymous_visitor_is_sent_to_log_in(client, db):
    response = client.get('/')

    assert response.status_code == 302
    assert response.headers['Location'].startswith('accounts/login/')


@pytest.mark.django_db
@override_settings(DEBUG=False)
def test_debug_off_serves_the_static_bundle(client, user):
    """index.html: the collected bundle, no webpack dev server needed.

    Every static URL the page emits has to resolve to a real file. It used to
    say {% static 'bundle.js' %} while the built file is static/dist/bundle.js,
    and the finders do not recurse -- asserting b'bundle.js' in content passed
    for that broken path and for a good one alike, so the production page
    loaded with two 404s. A blank app on the one configuration problems.txt
    deploys.
    """
    client.force_login(user)

    content = client.get('/').content.decode()

    urls = set(re.findall(r'"(/static/[^"]+)"', content))
    assert urls, 'the production template referenced no static files'
    for url in urls:
        assert finders.find(url[len(settings.STATIC_URL):]), \
            f'{url} is emitted but no such file exists'


@pytest.mark.django_db
@override_settings(DEBUG=False)
def test_debug_off_actually_serves_the_files_it_references(client, user):
    """The finders test above proves the path is right; this proves something
    answers it with the file. WhiteNoiseMiddleware indexed nothing with DEBUG
    off -- no STATIC_ROOT, no WHITENOISE_ROOT, and use_finders defaults to
    DEBUG -- so asset requests fell through to the catch-all and came back as
    the SPA shell (200 to a signed-in caller, 302 to the login page otherwise).
    Under daphne there is no runserver staticfiles handler to cover for it.

    Compared byte for byte, not by status: the catch-all answers 200 to a
    signed-in caller, so a status check passes on the broken configuration.
    """
    client.force_login(user)

    urls = set(re.findall(r'"(/static/[^"]+)"', client.get('/').content.decode()))
    assert urls, 'the production template referenced no static files'

    for url in sorted(urls):
        path = finders.find(url[len(settings.STATIC_URL):])
        # streaming_content, not content: whitenoise answers with a
        # StreamingHttpResponse, and the catch-all with a plain one.
        served = b''.join(client.get(url).streaming_content)
        assert served == Path(path).read_bytes(), \
            f'{url} is referenced by the app but not served'


@pytest.mark.django_db
@override_settings(DEBUG=True)
def test_debug_on_serves_the_webpack_bundle(client, user):
    """index-dev.html: render_bundle reads the committed webpack-stats.json.

    settings.py still defaults DEBUG to True, so this is the branch that
    actually runs in a plain `runserver`; it is also the one pytest-django
    would never exercise, because it forces DEBUG off for the whole suite.
    """
    client.force_login(user)

    response = client.get('/')

    assert response.status_code == 200
    assert b'<div id="app">' in response.content


@pytest.mark.django_db
def test_an_unknown_url_still_resolves_to_the_spa(client, user):
    """The catch-all is what makes client-side routing deep links work."""
    client.force_login(user)

    assert client.get('/no/such/page').status_code == 200


def _scratch_pages(directory):
    """Files under `directory` that look like a hand-rolled dev page.

    Both markers, not either one. `App.vue` legitimately builds a WebSocket,
    so "opens one" would condemn the whole app; what makes the page found here
    a development artifact is that its socket points at the machine it was
    written on.

    Source maps are skipped: they are build output, and they carry every
    `WebSocket(` in the app because they carry the app's source.
    """
    found = []
    for path in sorted(Path(directory).iterdir()):
        if path.suffix == '.map' or not path.is_file():
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue  # a binary asset, which cannot be a scratch page
        if 'WebSocket(' in text and ('localhost' in text or '127.0.0.1' in text):
            found.append(path.name)
    return found


def test_the_public_directory_holds_no_development_scratch_page():
    """`frontend/public/` is a copy list, not a source list.

    vue-cli-service copies this directory into the output verbatim rather than
    bundling it -- favicon, and the SPA shell it injects tags into. So a page
    dropped here is not caught by anything that reads the bundle: item 14's
    debug sweep looks inside `bundle.js`, and `public/index.html` is not in
    `bundle.js` either. It ships anyway, verbatim, and
    `WHITENOISE_USE_FINDERS` makes everything under `static/` public with DEBUG
    off.

    What was there: `test.html`, an otherwise empty page whose entire content
    was `new WebSocket('ws://localhost:8080/ws/notifications/')` and a bare
    `console.log` -- a socket test page written by hand during development,
    linked from nowhere in the app.
    """
    assert _scratch_pages(settings.BASE_DIR / 'frontend' / 'public') == []


def test_the_served_bundle_directory_holds_no_development_scratch_page():
    """The same check against the directory that is actually public.

    This is a separate claim because it fails differently. `static/dist/` is a
    committed artifact and only ./deploy.sh rebuilds it, so deleting the file in
    `public/` without rebuilding leaves
    the page served at `/static/dist/test.html` exactly as it was -- the source
    is clean and the defect is still reachable. That is the trap this project
    fell into with every frontend fix before the bundle was rebuilt, and here
    the build is the only thing that removes the file, which makes it the most
    likely way for it to survive.
    """
    assert _scratch_pages(settings.BASE_DIR / 'static' / 'dist') == []