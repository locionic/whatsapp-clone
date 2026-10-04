"""The OpenAPI schema endpoint.

It used to be routed at 'api/v1/', where include('rest_framework.urls') has
already claimed the path with DRF's API root -- so the schema was shadowed
and answered 401 (the root's IsAuthenticated default) instead of a schema.
"""


def test_schema_is_served(api_client):
    response = api_client.get('/api/v1/schema/')

    assert response.status_code == 200
    assert 'openapi' in response.data


def test_schema_is_public(api_client):
    """Declared public=True with AllowAny -- an unauthenticated client must
    get the schema, not a 401."""
    assert api_client.get('/api/v1/schema/').status_code == 200


def test_schema_describes_the_app_endpoints(api_client):
    paths = api_client.get('/api/v1/schema/').data['paths']

    assert '/api/v1/rooms/' in paths
    assert '/api/v1/messages/' in paths


def test_the_api_root_still_requires_authentication(api_client):
    """The view that used to shadow the schema."""
    assert api_client.get('/api/v1/').status_code in (401, 403)


def test_every_operation_id_is_unique(api_client):
    """operationId has to be unique across an OpenAPI schema or generated
    clients collide. DRF derives its base name from `view.queryset.model`, and
    both /messages/ and /messages/unread (and /rooms/ with /rooms/recents)
    declared one, so each pair collapsed onto the same id."""
    paths = api_client.get('/api/v1/schema/').data['paths']

    operation_ids = [
        op['operationId']
        for methods in paths.values()
        for method, op in methods.items()
        if method in ('get', 'post', 'put', 'patch', 'delete')
    ]

    assert len(operation_ids) == len(set(operation_ids))
