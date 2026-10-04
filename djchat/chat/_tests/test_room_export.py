"""Room export: `GET /api/v1/rooms/<id>/export?format=json|csv`.

The shape a download carries, and the two ways an export could quietly do
damage: reading a room you are not in, and consuming delivery state that the
read itself is not supposed to touch.
"""
import csv
import io
import json

import pytest


def export_url(room_id, as_=None):
    url = f'/api/v1/rooms/{room_id}/export'
    return f'{url}?as={as_}' if as_ else url


# ------------------------------------------------------------------- membership

def test_you_cannot_export_a_room_you_are_not_in(
        auth_client, user, other, make_user, make_room):
    """404, not 403 -- 403 would confirm the room exists."""
    stranger = make_user('carol')
    room = make_room(other, stranger)

    assert auth_client.get(export_url(room.id)).status_code == 404


def test_an_anonymous_caller_gets_nothing(api_client, user, other, make_room):
    room = make_room(user, other)

    assert api_client.get(export_url(room.id)).status_code in (401, 403)


# ------------------------------------------------------------------------ json

def test_json_export_carries_the_room_its_participants_and_messages(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, user, 'first', pending_reception=[other])
    make_message(room, other, 'second', pending_reception=[user])

    data = auth_client.get(export_url(room.id)).data

    assert data['room'] == {
        'id': room.id,
        'kind': room.kind,
        'group_name': room.group_name,
        'participants': sorted(
            [{'id': user.id, 'username': user.username, 'email': user.email,
              'tagline': user.tagline},
             {'id': other.id, 'username': other.username, 'email': other.email,
              'tagline': other.tagline}],
            key=lambda u: u['id'])}
    assert data['message_count'] == 2
    assert [m['body'] for m in data['messages']] == ['first', 'second']


def test_json_is_the_default_when_no_format_is_given(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    make_message(room, user, 'hi', pending_reception=[other])

    response = auth_client.get(export_url(room.id))

    assert response.status_code == 200
    assert response['Content-Type'].startswith('application/json')
    assert json.loads(response.content)['messages'][0]['body'] == 'hi'


def test_an_unknown_format_is_rejected(auth_client, user, other, make_room):
    room = make_room(user, other)

    assert auth_client.get(export_url(room.id, 'xml')).status_code == 400


# ------------------------------------------------------------------------ csv

def test_csv_has_a_header_and_one_row_per_message(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    mine = make_message(room, user, 'first', pending_reception=[other])
    theirs = make_message(room, other, 'second', pending_reception=[user])

    response = auth_client.get(export_url(room.id, 'csv'))

    assert response['Content-Type'].startswith('text/csv')
    assert response['Content-Disposition'] == \
        f'attachment; filename="room-{room.id}.csv"'
    rows = list(csv.reader(io.StringIO(response.content.decode())))
    assert rows[0] == ['id', 'author', 'body', 'timestamp']
    assert [(r[0], r[1], r[2]) for r in rows[1:]] == [
        (str(mine.id), str(user.id), 'first'),
        (str(theirs.id), str(other.id), 'second')]


def test_csv_quotes_a_message_containing_a_comma_and_a_newline(
        auth_client, user, other, make_room, make_message):
    """Hand-rolled string joining breaks on exactly this; csv.writer does not,
    which is the only reason this endpoint uses the stdlib module."""
    room = make_room(user, other)
    make_message(room, user, 'hi, there\nand again', pending_reception=[other])

    body = auth_client.get(export_url(room.id, 'csv')).content.decode()

    rows = list(csv.reader(io.StringIO(body)))
    assert rows[1][2] == 'hi, there\nand again'


def test_an_empty_room_exports_its_header_only(auth_client, user, other, make_room):
    room = make_room(user, other)

    assert auth_client.get(export_url(room.id)).data['messages'] == []

    rows = list(csv.reader(io.StringIO(
        auth_client.get(export_url(room.id, 'csv')).content.decode())))
    assert len(rows) == 1


# --------------------------------------------------------- export is a read only

def test_exporting_does_not_consume_pending_messages(
        auth_client, user, other, make_room, make_message):
    """RoomSerializer.get_last_message() calls remove_user_from_pending(), so
    serializing a room marks its last message as received -- and pushes
    all_received to the sender. That is right when the room is being opened
    and wrong for a download, which is why the room block here is assembled by
    hand instead of through RoomSerializer."""
    room = make_room(user, other)
    message = make_message(room, other, 'unseen', pending_reception=[user])

    auth_client.get(export_url(room.id))
    auth_client.get(export_url(room.id, 'csv'))

    message.refresh_from_db()
    assert list(message.pending_reception.all()) == [user]
    assert [m['id'] for m in auth_client.get(
        '/api/v1/messages/').data['messages']] == [message.id]


# ------------------------------------------------------------------ downloading

def test_both_formats_are_downloads(auth_client, user, other, make_room):
    """The endpoint is called "export" and has two formats, and only one of
    them behaved like one.

    `?as=csv` sets Content-Disposition, so a plain link downloads it and the
    page never leaves. `?as=json` -- the default -- answered a bare
    application/json Response, so a plain link navigated the tab away from the
    SPA and dumped the payload on screen. Two links in the same menu doing two
    different things, one of which loses your place.

    This is why the UI can be two bare <a href> tags with no JavaScript on
    either: the server decides. Anything that reaches this endpoint by URL --
    curl, a bookmark, another client -- gets the same answer.
    """
    room = make_room(user, other)

    csv_response = auth_client.get(export_url(room.id, 'csv'))
    json_response = auth_client.get(export_url(room.id, 'json'))
    default_response = auth_client.get(export_url(room.id))

    assert csv_response['Content-Disposition'] == \
        f'attachment; filename="room-{room.id}.csv"'
    assert json_response['Content-Disposition'] == \
        f'attachment; filename="room-{room.id}.json"'
    # The default has to download too, or `?as=` left off -- which is what a
    # bookmark and what any client that never reads the query string gets.
    assert default_response['Content-Disposition'] == \
        f'attachment; filename="room-{room.id}.json"'


def test_downloading_json_still_serves_json(auth_client, user, other, make_room):
    """The header is additive. A disposition does not change what the body is,
    and turning the export into something that is no longer JSON would fix the
    download by breaking the format."""
    room = make_room(user, other)

    response = auth_client.get(export_url(room.id, 'json'))

    assert response['Content-Type'].startswith('application/json')
    assert json.loads(response.content)['room']['id'] == room.id
