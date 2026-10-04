"""Every endpoint's authentication requirement, checked all at once.

Until now the requirement was pinned one endpoint at a time --
`test_requires_authentication` for `/me`, `test_lookup_by_email_requires_authentication`
for the user lookup -- so the guarantee covered exactly the endpoints somebody
remembered to write a test for. This walks the URLconf instead, so an endpoint
added without authentication is red on arrival rather than on the next audit.

**The class-level scan lies, and that is why this issues requests.**
`permission_classes` passed to `as_view()` lands on the *instance*, not on the
class, so `SchemaView.permission_classes` reads `IsAuthenticated` while the view
actually serving `/api/v1/schema/` is `AllowAny`. A test that read the class
would have reported the one public endpoint in this app as protected -- wrong
in the unsafe direction, and invisible.

The schema's *content* is already covered where it belongs, in
`chat/_tests/test_schema_endpoint.py`. This file is only about access.
"""
import collections

import pytest

from django.urls import get_resolver
from django.urls.resolvers import URLPattern, URLResolver

# `djchat/urls.py` builds `schema_view` with `public=True` and
# `permission_classes=(permissions.AllowAny,)`. One deliberate exception, written
# down here rather than assumed, so a second one is a visible edit.
PUBLIC_API_ROUTES = {'/api/v1/schema/'}

# The converters this app actually uses in a path. An id that does not exist is
# fine: an anonymous caller is turned away before any lookup, so `1` never has to
# be a real row. That is the whole property under test.
CONVERTERS = ('room_id', 'user_id', 'friendship_request_id')


def _walk(resolver, prefix=''):
    for entry in resolver.url_patterns:
        pattern = prefix + str(entry.pattern)
        if isinstance(entry, URLResolver):
            yield from _walk(entry, pattern)
        elif isinstance(entry, URLPattern):
            yield pattern, entry


def _endpoints():
    """Every DRF endpoint under `api/`, as a url that resolves.

    Filtered on the view carrying `permission_classes`, which is what makes a
    view DRF's. That excludes the SPA catch-all `^.*$` -- `IndexTemplateView`
    has no permissions at all, and a request to a made-up `api/` path lands on
    it and is redirected to the login page, which is a *different* endpoint
    answering, not this endpoint being open.

    It also excludes `api/v1/login/` and `api/v1/logout/`, which are
    `rest_framework.urls`' own Django views and are *supposed* to be anonymous.
    """
    seen, urls = set(), []
    for pattern, entry in _walk(get_resolver()):
        if not pattern.startswith('api/'):
            continue
        # the router's `^messages\.(?P<format>...)$` is a second route onto a
        # view already listed; its regex group is not a path converter.
        if '(?P<' in pattern:
            continue
        cls = getattr(entry.callback, 'cls', None)
        if cls is None or not hasattr(cls, 'permission_classes'):
            continue
        if '<' in pattern and not any('<int:%s>' % c in pattern for c in CONVERTERS):
            continue          # `drf_format_suffix`, `path:` -- not one of ours

        url = pattern
        for name in CONVERTERS:
            url = url.replace('<int:%s>' % name, '1')
        # The router hands over `^messages/$`.
        url = '/' + url.replace('^', '').replace('$', '')
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


@pytest.mark.django_db
def test_every_api_endpoint_rejects_an_anonymous_caller(api_client):
    """The sweep itself.

    GET and POST are both sent at every endpoint, and both have to be refused.
    Two methods rather than "the right one per view" because a view set's
    handlers are bound onto the *instance* by `as_view({'get': 'list'})` and
    cannot be read off the class -- and because it does not matter: `dispatch()`
    runs `initial()`, which is where `check_permissions` lives, *before* it
    looks up a handler at all. So an unauthorized caller is refused whatever it
    asks for, including a verb the view does not implement.
    """
    endpoints = _endpoints()
    assert len(endpoints) >= 20, (
        'the URLconf walk found only %d endpoints, so this test is asserting '
        'almost nothing' % len(endpoints))

    # The test client re-raises a view's unhandled exception instead of turning
    # it into a 500. Left on, the first endpoint that crashes for an anonymous
    # caller aborts the loop and the sweep reports nothing at all -- a blind
    # test that still looks like it ran. Off, the crash arrives as the 500 it
    # would be in production, and counts as an offender like any other answer.
    api_client.raise_request_exception = False

    reachable = []
    for url in endpoints:
        if url in PUBLIC_API_ROUTES:
            continue
        for method in ('GET', 'POST'):
            status = api_client.generic(method, url, {}, {}).status_code
            if status not in (401, 403):
                reachable.append('%s %s -> %s' % (method, url, status))

    assert reachable == [], (
        'reachable without a session: %s' % '; '.join(reachable))


def test_the_routes_the_sweep_skips_are_the_django_ones():
    """The other side of the sweep's filter, so it cannot leak.

    101 routes are registered and only the DRF ones are checked. The 74 this
    test does not check are not 74 unknowns -- they are 59 admin, 12
    `django.contrib.auth.urls`, DRF's own `login/` and `logout/`, and the SPA
    catch-all, all of which carry their own access control. Asserting the
    breakdown means a new plain Django view wired under `/api/` fails here
    instead of joining the unchecked set in silence.
    """
    skipped = collections.Counter()
    api_django = set()
    for pattern, entry in _walk(get_resolver()):
        cls = getattr(entry.callback, 'cls', None)
        if cls is not None and hasattr(cls, 'permission_classes'):
            continue
        prefix = pattern.split('/')[0] or '(root)'
        skipped[prefix] += 1
        if pattern.startswith('api/'):
            api_django.add('/' + pattern)

    assert skipped == {'admin': 59, 'accounts': 12, 'api': 2, '^.*$': 1}, (
        'the unchecked routes changed shape: %r' % dict(skipped))
    assert api_django == {'/api/v1/login/', '/api/v1/logout/'}, (
        'a plain Django view is reachable under /api/: %r' % sorted(api_django))


@pytest.mark.django_db
def test_the_schema_is_the_only_public_endpoint(api_client):
    """Pins the exception rather than tolerating it.

    The first test skips whatever is in `PUBLIC_API_ROUTES`, so a second entry
    there would silently stop being checked. This is the review: the set has one
    member, that member really is public, and the file that grants it says so.
    """
    assert PUBLIC_API_ROUTES == {'/api/v1/schema/'}, (
        'the public allowlist changed; a new entry needs to be a decision, '
        'not an edit: %r' % sorted(PUBLIC_API_ROUTES))

    assert api_client.get('/api/v1/schema/').status_code == 200