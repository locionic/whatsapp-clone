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
CONVERTERS = ('room_id', 'user_id', 'friendship_request_id', 'message_id')

# The DRF routes under `api/` the sweep knowingly does not request, as
# `(pattern, reason)`. **Written down, not discovered** -- see
# `test_no_drf_route_falls_out_of_the_sweep_in_silence` for how this list got
# its first entry, by a route arriving that was in none of the sweep's filters.
EXPECTED_UNSWEPT_DRF_ROUTES = {
    # DRF's `include_format_suffixes` route, mounted once on the include. It
    # matches nothing on its own -- it is the prefix for `messages.json` and
    # friends -- and every view it can reach is one the sweep requests already.
    ('api/v1/<drf_format_suffix:format>', 'not a path converter'),
    # The same thing once per registered viewset: a second route onto
    # `messages/$` and `rooms/$`, which the sweep does request.
    #
    # **The router's *detail* route is not on this list because it does not
    # exist**, which is worth stating here rather than leaving to a reversion:
    # walking the resolver gives 30 routes under `api/` -- 28 DRF and the two
    # plain Django login/logout -- and the four the router contributes are
    # `^messages/$`, `^rooms/$` and their two format suffixes. There is no
    # `^messages/(?P<pk>...)/$` to ask about, so there is nothing to write down.
    # If one is ever registered it will contain `(?P<`, which puts it in
    # `dropped`, and this file will then require a decision about it instead of
    # skipping it quietly.
    ('api/v1/^messages\\.(?P<format>[a-z0-9]+)/?$', 'router regex'),
    ('api/v1/^rooms\\.(?P<format>[a-z0-9]+)/?$', 'router regex'),
}


def _walk(resolver, prefix=''):
    for entry in resolver.url_patterns:
        pattern = prefix + str(entry.pattern)
        if isinstance(entry, URLResolver):
            yield from _walk(entry, pattern)
        elif isinstance(entry, URLPattern):
            yield pattern, entry


def _endpoints():
    """Every DRF endpoint under `api/`, as a url that resolves, and what it
    dropped on the way.

    Filtered on the view carrying `permission_classes`, which is what makes a
    view DRF's. That excludes the SPA catch-all `^.*$` -- `IndexTemplateView`
    has no permissions at all, and a request to a made-up `api/` path lands on
    it and is redirected to the login page, which is a *different* endpoint
    answering, not this endpoint being open.

    It also excludes `api/v1/login/` and `api/v1/logout/`, which are
    `rest_framework.urls`' own Django views and are *supposed* to be anonymous.
    Those are the plain-Django skips, and they are asserted by name in
    `test_the_routes_the_sweep_skips_are_the_django_ones`. The two below are not,
    and both used to `continue` in silence -- which is the whole point of the
    second return value.
    """
    seen, urls, dropped = set(), [], []
    for pattern, entry in _walk(get_resolver()):
        if not pattern.startswith('api/'):
            continue
        # the router's `^messages\.(?P<format>...)$` is a second route onto a
        # view already listed; its regex group is not a path converter.
        if '(?P<' in pattern:
            dropped.append((pattern, 'router regex'))
            continue
        cls = getattr(entry.callback, 'cls', None)
        if cls is None or not hasattr(cls, 'permission_classes'):
            continue
        if '<' in pattern and not any('<int:%s>' % c in pattern for c in CONVERTERS):
            dropped.append((pattern, 'not a path converter'))
            continue          # `drf_format_suffix`, `path:` -- not one of ours

        url = pattern
        for name in CONVERTERS:
            url = url.replace('<int:%s>' % name, '1')
        # The router hands over `^messages/$`.
        url = '/' + url.replace('^', '').replace('$', '')
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls, dropped


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
    endpoints, _dropped = _endpoints()
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


def test_no_drf_route_falls_out_of_the_sweep_in_silence():
    """The sweep's own skip rules, asserted -- because one of them ate a route.

    `test_the_routes_the_sweep_skips_are_the_django_ones` counts the routes with
    no `permission_classes`, so it is blind to both rules here: a DRF view is
    invisible to it whether it is swept or not. Its docstring says it exists "so
    it cannot leak", and this is the leak.

    **Item 97 is what opened it.** `messages/<int:message_id>/delete` is the
    first route in this URLconf whose converter name is not in `CONVERTERS`, so
    the sweep's `not any(...)` guard dropped it -- and the endpoint item 97
    added was never requested anonymously by anything in this suite. It is
    genuinely protected, because `DEFAULT_PERMISSION_CLASSES` is
    `IsAuthenticated` and no view overrides it, but that is a fact about the
    settings rather than a fact this file proved, and the whole premise of the
    file is that an unaudited endpoint must not be able to slip in.

    So the dropped set is asserted rather than allowed. Each entry is a decision:
    either the route joins the sweep, or it is written down here as one that is
    knowingly unchecked. A new one is red on arrival, which is what the file
    promises.
    """
    _swept, dropped = _endpoints()

    assert set(dropped) == EXPECTED_UNSWEPT_DRF_ROUTES, (
        'DRF routes the sweep does not request changed shape:\n%s' % '\n'.join(
            '  %-44s %s' % pair for pair in sorted(dropped)))


def test_the_message_delete_route_is_among_the_urls_the_sweep_requests():
    """The route item 97 added, named rather than counted.

    The test above catches a route that *falls out* of the sweep. This catches
    the cheaper mistake of writing the route down instead of checking it:
    dropping `message_id` from `CONVERTERS` and listing the route in
    `EXPECTED_UNSWEPT_DRF_ROUTES` would satisfy both that assertion and the
    django-views one, and the endpoint would go unaudited with every test in
    this file green -- the one shape of the failure this file exists to prevent
    that the other test cannot see. So the membership is stated on its own.
    """
    endpoints, _dropped = _endpoints()

    assert '/api/v1/messages/1/delete' in endpoints


def test_the_routes_the_sweep_skips_are_the_django_ones():
    """The other side of the sweep's filter, so it cannot leak.

    102 routes are registered and only the DRF ones are checked. The 74 this
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