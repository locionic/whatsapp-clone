"""Room activity: `GET /api/v1/rooms/<id>/activity`.

The chart draws one bar per day and reads them by position, so the two ways
this can quietly lie are a sparse series (a gap plots the wrong day) and a
mis-ordered one. Both are asserted on the shape rather than on any single
count, because one wrong count still looks like a plausible chart.
"""
import re
from datetime import timedelta
from pathlib import Path

from django.utils import timezone

from chat.api.roomViews import ACTIVITY_DAYS
from chat.models import Message


def activity_url(room_id):
    return f'/api/v1/rooms/{room_id}/activity'


def days_ago(n):
    return timezone.localdate() - timedelta(days=n)


def backdate(message, n):
    """Move a message into the past. `timestamp` is auto_now_add, so the field
    is owned on insert and a queryset update is the only way to set it."""
    Message.objects.filter(id=message.id).update(
        timestamp=timezone.now() - timedelta(days=n))


def counts_by_date(data):
    return {row['date']: row['count'] for row in data['per_day']}


# ------------------------------------------------------------------- membership

def test_you_cannot_read_activity_for_a_room_you_are_not_in(
        auth_client, user, other, make_user, make_room):
    """404, not 403 -- 403 would confirm the room exists."""
    stranger = make_user('carol')
    room = make_room(other, stranger)

    assert auth_client.get(activity_url(room.id)).status_code == 404


def test_an_anonymous_caller_gets_nothing(api_client, user, other, make_room):
    room = make_room(user, other)

    assert api_client.get(activity_url(room.id)).status_code in (401, 403)


# ----------------------------------------------------------------------- shape

def test_the_series_is_dense_ordered_and_ends_today(auth_client, user, other, make_room):
    """A day with no messages still gets an entry, so bar i is always the same
    date instead of shifting left whenever someone is quiet."""
    room = make_room(user, other)

    data = auth_client.get(activity_url(room.id)).data

    assert len(data['per_day']) == ACTIVITY_DAYS
    assert data['per_day'][0]['date'] == days_ago(ACTIVITY_DAYS - 1).isoformat()
    assert data['per_day'][-1]['date'] == timezone.localdate().isoformat()
    assert all(row['count'] == 0 for row in data['per_day'])
    assert data['total'] == 0
    assert data['peak'] == 0


# ---------------------------------------------------------------------- counts

def test_messages_land_on_their_own_day(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    for n, how_many in ((0, 3), (1, 1), (5, 2)):
        for _ in range(how_many):
            backdate(make_message(room, other, 'hi'), n)

    by_date = counts_by_date(auth_client.get(activity_url(room.id)).data)

    assert by_date[days_ago(0).isoformat()] == 3
    assert by_date[days_ago(1).isoformat()] == 1
    assert by_date[days_ago(5).isoformat()] == 2
    assert by_date[days_ago(4).isoformat()] == 0


def test_total_and_peak_span_the_whole_window(
        auth_client, user, other, make_room, make_message):
    room = make_room(user, other)
    for _ in range(4):
        backdate(make_message(room, other, 'hi'), 2)
    backdate(make_message(room, other, 'hi'), 9)

    data = auth_client.get(activity_url(room.id)).data

    assert data['total'] == 5
    assert data['peak'] == 4


def test_messages_older_than_the_window_are_excluded(
        auth_client, user, other, make_room, make_message):
    """Otherwise a year-old room reports activity in days the chart never
    draws, and the totals stop matching what is on screen."""
    room = make_room(user, other)
    backdate(make_message(room, other, 'ancient'), ACTIVITY_DAYS)
    backdate(make_message(room, other, 'recent'), 1)

    data = auth_client.get(activity_url(room.id)).data

    assert data['total'] == 1
    assert all(row['count'] == 0 for row in data['per_day'][:-2])
    assert data['per_day'][-2]['count'] == 1


def test_another_rooms_messages_are_not_counted(
        auth_client, user, other, make_user, make_room, make_message):
    carol = make_user('carol')
    mine = make_room(user, other)
    theirs = make_room(user, carol)
    backdate(make_message(mine, other, 'mine'), 0)
    backdate(make_message(theirs, carol, 'theirs'), 0)

    data = auth_client.get(activity_url(mine.id)).data

    assert data['total'] == 1
    assert data['per_day'][-1]['count'] == 1


# -------------------------------------------------------- client/server seam

def test_the_response_carries_every_key_the_chart_reads(
        auth_client, user, other, make_room, settings):
    """The chart reads five keys off this response and nothing compares the halves.

    `RoomActivityAPIView` builds the dict, `fetchRoomActivity` commits
    `response.data` untouched, and `ContactProfile.vue` reads `getActivity.total`
    and `getActivity.days` in the summary line, `activity.room_id` in the
    stale-response guard, and `activity.per_day` / `activity.peak` in `getBars`.
    The other three are pinned by the tests above. These two are not, and both
    fail silently rather than loudly:

      - Renaming `room_id` leaves `activity.room_id` undefined, so
        `undefined !== this.getRoom.id` is true for every room and `getActivity`
        returns null always. The chart never draws, and the panel says "No
        messages in this chat yet" above a chat that has messages in it. The
        guard that exists to stop one room's bars appearing under another's name
        is the thing that breaks.
      - Renaming `days` renders "12 messages in the last undefined days",
        repeats it in the aria-label, and labels the left axis "undefined days
        ago".

    Neither raises and neither logs. Measured, before this test existed: each
    mutation in turn left pytest at `52 passed` (this file plus
    `test_room_api.py`) *and* jest at `134 passed, 134 total` -- the whole
    suite, because jest never loads the server. jest cannot catch either:
    `room_activity_chart.spec.js` builds its payload from `activityFor()`, so
    it asserts the keys against itself.

    Read from the source rather than the built bundle, for the reason
    `test_the_group_name_cap_matches_the_model` gives: the bundle is a build
    artifact that can be stale.
    """
    component = (
        Path(settings.BASE_DIR) / 'frontend' / 'src' / 'components' /
        'profiles' / 'ContactProfile.vue'
    ).read_text(encoding='utf-8')

    # The two names the payload answers to, anchored on a non-word character so
    # `state.roomActivity` and `getActivity()` cannot match either form.
    read = set(re.findall(
        r'(?<![A-Za-z0-9_])(?:getActivity|activity)\.([A-Za-z_]\w*)',
        component))

    # Without this, a rename of the computed itself leaves an empty match and
    # the assertion below passes on nothing -- the cap test's other half.
    assert read, ('ContactProfile.vue reads no key off the activity payload, so '
                  'this test is asserting nothing')

    room = make_room(user, other)
    data = auth_client.get(activity_url(room.id)).data

    assert read <= set(data), (
        'ContactProfile.vue reads %r, the endpoint returns %r'
        % (sorted(read), sorted(data)))