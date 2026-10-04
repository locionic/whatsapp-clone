# djchat roadmap

## Phase 1 - API transcription (complete)

The plan was never a file. It lived as Spanish comments in the test modules
(`que no pueda ver mensajes de otras personas`, `verificar que el envio de
mensaje actualiza el timestamp`, ...), and every block is now covered by the
suite that replaced it.

| Plan source | Executed by |
|---|---|
| `chat/_tests/message_test.py` | `chat/_tests/test_message_api.py` |
| `chat/_tests/room_test.py` | `chat/_tests/test_room_api.py` |
| `friends/api/test.py`, `users/_tests/tests.py` | `friends/_tests/`, `users/_tests/` |
| (none - the websocket was untested) | `chat/_tests/test_consumer.py` |

The two plan files are kept as the record of what was asked for. They are not
collected by pytest, so they cost nothing.

## Phase 2

### 1. Export a room's messages (done)

`GET /api/v1/rooms/<id>/export?as=json` (default) or `?as=csv`.

The one thing a chat app should let you do with your data, and the only
Phase 2 item the backend can be tested against. `csv` because spreadsheets,
`json` because re-import and scripting.

Reuses `MessageSerializer` and `UserSerializer` rather than adding shapes.
The `room` block is built by hand on purpose: `RoomSerializer.get_last_message`
calls `remove_user_from_pending`, so reusing it would make a read-only
download mark the room's last message as received and push `all_received` to
the sender.

**`as`, not `format`.** `format` is DRF's `URL_FORMAT_OVERRIDE`: content
negotiation reads it off the query string, finds no renderer registered for
`csv`, and 404s before the view is ever reached. `?format=csv` returns 404.

**Verified by:** `chat/_tests/test_room_export.py` - membership, both formats,
the CSV header and quoting, and that an export does not consume pending state.

### 2. Reconnect the websocket (done)

`App.vue` set `chatSocket.onclose` to an empty function and never retried, so
one `daphne` restart - or one network blip - ended real-time updates for that
tab for the rest of the session: no error, the chat just quietly stopped
updating. `onclose` now backs off (1s doubling to 30s) and reconnects, reset on
each successful open.

The URL scheme is now derived from `window.location.protocol` instead of being
hardcoded to `wss://`. That is part of the same fix rather than extra scope:
a hardcoded `wss` can never reach a local `npm run serve` over http, so adding
retry without it would have produced an endless reconnect loop in dev.

**Verified by:** `test_a_client_that_comes_back_rejoins_its_group` - a socket
that disconnects and reconnects receives pushes again, which is what makes the
retry safe - and `tests/unit/websocket_reconnect.spec.js`, which covers the
backoff and the scheme, the half Django cannot see.

### 3. Pin the unread payload (done)

`ADD_UNREAD_MESSAGES` stores `element.room` and `User.vue` badges rooms by that
value. Dropping `room` from `UnreadMessageSerializer` left all 180 tests green
and would have made every unread badge in the app silently disappear.

**Verified by:** `test_unread_items_name_the_room_they_belong_to`, mutation
checked - removing `room` fails exactly that test.

### 4. Data visualization (done)

`GET /api/v1/rooms/<id>/activity` - messages per day for one room over a 30-day
window, plus `total` and `peak`. Drawn as one bar per day in the contact
profile, next to the tagline.

It answers the one question the rest of the UI cannot: when are these people
actually around. No charting dependency - the SVG is a `<rect>` per day scaled
against `peak`, and the viewBox is as wide as the series, so changing
`ACTIVITY_DAYS` cannot silently misalign it.

`room_id` comes back in the payload and is matched in the component rather than
just fetched: switch rooms faster than the request returns and you would
otherwise draw the previous room's bars under the new room's name. `RoomSerializer`
is not involved, so opening the profile to look at the chart does not mark
anything as received.

**Verified by:** `chat/_tests/test_room_activity.py` - membership, the dense
ordered series, counts landing on the right day, the window excluding older
messages, another room's messages not being counted. Mutation-checked four
ways - dropping the zero-fill, reversing the series, removing the window filter
and summing the whole room each fail it.

**Verified by:** `tests/unit/room_activity_chart.spec.js` for the geometry, and
`chat/_tests/test_room_activity.py` for the payload.

### 5. Rejected invitations never left the tabs (done)

Not an enhancement - a defect, recorded here because it was on the list of
things a test runner was blocking.

`UserInvitation.vue` draws no state at all: no rejected styling, no disabled
button. Both list queries filtered on nothing relevant - `requests` on
`to_user`, `sent_requests` on `from_user` - so a rejected invitation came back
looking live. A working Cancel button in Sent, a working accept button in
Received, and a count against the Sent badge, for as long as the row existed.

The row has to survive: `rejected_requests` is built from it, and `add_friend`
reads it as a dismissal rather than a standing refusal. So the lists leave it
out instead - both queries now filter `rejected__isnull=True`, which is also
the WhatsApp behaviour this app is modelled on.

Reviving is the part that had to keep working: `add_friend` nulls `rejected` on
the existing row, so asking again puts the invitation back. Filtered without
that, a second ask would be silently invisible.

**Verified by:** `friends/_tests/test_friendship_api.py` - a pending invitation
on both sides, a rejected one gone from both, and the re-ask reappearing.
Mutation-checked three ways: unfiltering either query, or dropping
`reject()`'s cache bust, each fails exactly the intended test.

`test_rejecting_reaches_the_senders_list` changed shape. It asserted the
sender's list carried `rejected=<timestamp>`, which is what a stale warm cache
used to produce; that is now the bug rather than the fix. It asserts the list is
empty instead, which a stale cache still fails.

### 6. `?email=` handed out profile bios (done)

`GET /api/v1/users?email=` serialized with the shared `UserSerializer`, so any
signed-in caller could name any address and read back that account's `tagline` -
a free-text bio. Guessable addresses turned it into a profile reader for
strangers. It now serializes with a new `EmailLookupSerializer`
(`id, username, email`).

**A new class, not a narrower `UserSerializer`.** Four production modules import
that one (`users/api/views`, `chat/api/messageViews`, `chat/api/serializers`,
`chat/api/roomViews`); trimming it would have taken `tagline` out of group
profiles and every chat participant too. `CurrentUserAPIView` keeps the full
serializer - your own profile is where your own bio belongs.

`username` stays even though the invite flow reads only `response.data.id`: the
app already shows usernames to peers in group and participant profiles, so
dropping it here would close nothing. `email` merely echoes what the caller sent.

**Verified by:** `test_lookup_by_email_does_not_hand_out_a_profile_bio` and
`test_your_own_profile_still_carries_your_tagline`. Mutation-checked three ways -
pointing the view back at `UserSerializer`, adding `tagline` to
`EmailLookupSerializer`, and pointing `CurrentUserAPIView` at the narrow
serializer each fail the intended test.

**Still true after the fix:** the endpoint remains an existence oracle - 200 with
an id for a real address, 404 otherwise. That is inherent to invite-by-email;
closing it means changing the flow, not this response.

### 7. Creating a room told nobody (done)

`RoomViewSet.create` was the only one of the seven push sites that pushed
nothing. A group is the only room anyone can appear in without acting first, so
adding Bob and Carol to a new group left them with no room in their client until
they reloaded by hand - no error, the sidebar just stayed as it was.

It now sends `update_rooms` to the room's participants, which is the message
`App.vue` already answers with `fetchRooms`. No new push type, so no client
change. Every other push site already did this; the accept signal sends the
identical call for the private room it creates.

The private branch pushes on `created`, not on every call: `POST /rooms` with
`kind=1` is idempotent, and re-opening a chat both people already have should
not make the other one refetch for nothing.

**Verified by:** `chat/_tests/test_consumer.py` - the group push reaching the
creator, another member, and a member later in the list, plus both halves of the
`created` guard. Mutation-checked three ways: dropping the group push fails
exactly the three group tests, pushing on every private call fails the guard
test, and never pushing fails the create test.

### 8. A failed profile save said nothing (done)

`patchUserProfile` caught a rejected PATCH and only `console.log`ged it. The Save
button re-enabled, no alert appeared, and the bio the user had just written sat
in the textarea looking saved - the old one was still in the database. Silent
loss of what the user just typed.

Two root causes, both fixed:

- **`UserProfile.vue` has no `maxlength` on the textarea.** `tagline` is
  `max_length=1024` (verified: DRF builds `CharField(max_length=1024)`), so
  pasting a long bio 400s. Now `:maxlength="maxTagline"`, the native mechanism
  for this - no counter component, no validator.
- **The catch is now a red banner.** `SuccessAlert` grew an `error` prop rather
  than a second component: same banner, one flag, and it is the only place a
  failed save could have been reported. The two alerts are a `v-if`/`v-else-if`
  chain because a `<transition>` takes a single child.

**Verified by:** `tests/unit/profile_save.spec.js` - a failed save says "not
saved" and renders red, a successful one does not, neither shows before a save,
the textarea is capped at 1024, and the button is re-enabled after a failure.
Mutation-checked two ways: putting `console.log` back in the catch fails exactly
the failure test, and removing `:maxlength` fails exactly the cap test.

`mount`, not `shallowMount` - the copy the user reads lives inside the child, and
a stub leaves "not saved" unassertable. Two assertions I wrote first were wrong
and are recorded because the failures were informative rather than mysterious: a
`<transition>` cannot hold two independent `v-if`s, and `.success-alert` is the
component root while the colour lives on the inner banner.

**Rebuilt and verified in the artifact**, since `dist/` is what the app loads:
`maxTagline`, `showErrorAlert`, `not saved`, `text-red-900`, `maxlength` all
present, and the old `case 10:this.isPatching=console.log(t.t0)` is now
`case 10:this.isPatching=!1`. Every earlier fix survives the rebuild - `retryDelay`,
`reconnectWebSocket`, the protocol-derived `wss://`, `fetchRoomActivity`,
`SET_ROOM_ACTIVITY`, `viewBox`; `onclose=function(){}` still 0. The stylesheet
kept every class: `.activity`, `.closebtn`, `.fade-enter`, `.user-row`,
`.scrollbar` all still there. `.success-alert` is 0 because that component has
no `<style>` - the class is a test hook, not a styled one.

### 9. Every chat opened newest-message-first (done)

The one that had to be read end to end, because no single file is wrong.

`App.vue` awaits `fetchRooms` and *then* `fetchMessages`, and both commit
`LINK_MESSAGES_TO_ROOM` - the same mutation, on the same per-room array. The
two payloads are not in the same order, and neither can be:

- `GET /rooms/` ships each room's **newest** message, as `last_message`
  (`RoomSerializer.get_last_message`). That same call runs
  `remove_user_from_pending`, so the message is already consumed and
  `GET /messages/` will not return it again.
- `GET /messages/` returns what is still pending for you, **older** ones,
  ascending.

The mutation appended blindly, so `roomMessages[R]` was `[M5, M1, M2, M3, M4]`.
`MessagesSection` renders the array top to bottom, so the newest message sat at
the *top* of the thread with the older ones below it, and `scrollToBottom()`
parked the reader on a stale message - on every app load, in every room.

`LINK_PAST_MESSAGES_TO_ROOM` had the mirror defect: it spread
`state.roomMessages[roomId]`, which is `undefined` for a room with no messages
- such a room is never entered, because `/rooms/` only ever carries a
`last_message` and there is none. `...undefined` is a `TypeError`, thrown
inside the `.then` in `actions.js`, rejected, and swallowed by the `.catch` in
`MessagesSection`. The first open of every new chat therefore learned nothing.

One helper, `mergeMessages`, now backs both mutations: concatenate, dedupe,
sort by `id`. `id` is the key because it is monotonic and it is what the backend
paginates on (`id__lt=offset`). **Pending messages sort last, not first:**
`position()` returns `Infinity` for a message with no `id`, and the sort is
stable, so messages you have typed but not yet sent keep the order you typed
them in.

**Dedupe on `front_key`, not `id`** - the trap. An optimistic message has no
`id` until the server answers, so every pending message shares the key
`undefined` and a merge on `id` collapses them into one, silently eating
something the user just sent.

**Verified by:** `tests/unit/room_message_order.spec.js` - 7 tests, run before
the fix and watched fail. The no-messages room, the newest-first ordering,
duplicates, messages landing in the room they name, a sending message keeping
its place and gaining its id, and the two-pending-messages hazard above.

Mutation-checked four ways, each failing exactly the named test: blind append
(ordering), dropping the `|| []` (the crash), deduping on `id` (the two pending
messages), and dropping the sort (ordering).

**Two things the tests do not claim.** "A message that arrives again is not
shown twice" passes even with the merge's dedup removed - `LINK_MESSAGES_TO_ROOM`
already filters on `state.receivedMessages` first. It pins the guard, not the
merge; the merge's dedup is pinned by the `front_key`-vs-`id` test. And there
is no Django-side test for this item, because no Django behaviour changed - the
contract it relies on (every serialized message carries `front_key`) is
`MessageSerializer` excluding only the two m2m.

**Still open, from the same read of the store:** a failed send used to leave its
message on the clock icon forever (that is item 10, now done), and closing a
chat used to 404 (item 11, now done).

### 10. A refused send stayed on its clock icon forever (done)

Not an enhancement - a silent loss, and the last of the two store defects item 9
surfaced.

`SendForm.sendMessage` puts the message on screen (`LINK_MESSAGES_TO_ROOM`,
`sending: true`) and empties the input *before* dispatching, and the dispatch
had no `.catch`. Nothing else ever takes either back: `sending` is only ever
cleared by the server's own copy coming back through `LINK_MESSAGES_TO_ROOM`.
So a rejected POST left the bubble on its `access_time` clock - in the thread
(`SentMessage.vue:16`) and in the room list (`User.vue:43`) - for the rest of
the session, plus a `sendingPool` entry nothing would ever consult. No error,
no bubble, no event. The text was gone from the box and visibly not sent.

A rejection is reachable, not theoretical: a peer removes you from the room
between the render and the click (403), the body trips a validator (400), the
database hiccups (500), or the request is dropped on the way out. It was also
observable from the outside - the unhandled rejection was enough to take down
the node process running the test suite.

**Three things to undo, not one.** `REMOVE_FAILED_MESSAGE` removes the bubble,
drops the pool entry, *and* unregisters the `front_key` from
`receivedMessages`. That last one is the trap and the reason this is not just
"take the message back out":

`SendForm` commits `LINK_MESSAGES_TO_ROOM` **before** `ADD_MESSAGE_TO_SENDING`,
so the optimistic message misses the sendingPool branch and registers its
`front_key` in `receivedMessages` - the store's already-seen-this set. A POST
can reach the server and still reject the client (the response is lost on the
way back). The message then exists, the peer has it, and the push carries that
same `front_key`. Leaving the registration behind makes the sender's copy of a
delivered message the one message the sender never sees. Removing the bubble is
what makes that reachable, so removing the bubble is what has to undo it.

**Two halves, because the store cannot own the other one.** The action commits
the rollback and re-rejects; `SendForm` catches to put the text back in the box,
because that is component state. It only restores when the box is *still* empty -
a refusal takes a round trip, and anything typed since is newer and wanted.
Unconditional restore trades a lost send for a lost send-plus-a-second-message.

**Verified by:** `tests/unit/failed_send.spec.js` - the bubble and pool entry
gone, the delivered-anyway message still able to arrive, the text back in the
box, and the text typed since left alone. Watched fail before the fix: the
store test on `REMOVE_FAILED_MESSAGE is not a function`, and the form tests by
killing the runner with the unhandled rejection.

Mutation-checked three ways, each failing exactly the named test: keeping the
bubble, leaving the `receivedMessages` registration behind, and restoring the
text unconditionally. The missing `.catch` needs no mutation - it is what the
pre-fix suite did on its own.

**Spotted while fixing it, now fixed:** because of that commit order, *every*
message a user sent - not just failed ones - added a `front_key` to
`state.receivedMessages`, and nothing ever removed one. That is item 13, and it
is done.

### 11. Closing a chat asked the server for `messages/null` (done)

The last of the two store defects items 9 and 10 surfaced.

`fetchPastMessages` read `selectedRoom` and used it straight away. It has two
callers - the `selectedRoom` watcher and `onScroll` - and the watcher fires on
every change *including* the change to `null`. So closing a chat dispatched
`GET /api/v1/messages/null`, which `chat/api/urls.py:9` (`messages/<int:room_id>`)
cannot match: it 404ed at URL resolution, and the `.catch` on the dispatch then
set `fetchingMessages` back to `false` as if it had all worked out.

This is not an edge case, it is the normal way the app is used. Three separate
places commit `SET_SELECTED_ROOM(null)`: `SideRooms.vue:62` - *closing the room
drawer*, an ordinary gesture - `ContactProfile.vue:148` (delete chat) and
`App.vue:42` (a peer removed you). Every chat close made a doomed request.

**The guard is in `fetchPastMessages`, not in the watcher.** `onScroll` reaches
the same method, and the scroll pane stays mounted with no room open, so
scrolling it fired the same 404. A watcher-only guard would have fixed the
common case and left that one.

**Verified by:** `tests/unit/closed_room.spec.js` - the watcher path, the
scroll path, and that an open chat still pages its history (a guard that always
returned would pass the first two and break the feature).

Mutation-checked: with the guard removed, exactly those two fail. Moving it to
the watcher instead also fails both, because the tests call the method - which
is the point of putting it there.

**Still open, and deliberately not fixed here:** `noMoreMessages` was component
state set from whichever request was in flight, so a late page could cap the
wrong chat's history. That is item 12, and it is now done.

### 12. A late page capped the wrong chat's history (done)

`noMoreMessages` is component state, not per-room, and it was set from whichever
response happened to be in flight. The watcher resets it on every room change, so
it looks correct right up until you switch rooms while a request is still open -
the single most ordinary thing a chat user does. Room A's "there is nothing
older" then landed and set the flag for room B, and nothing re-armed it until a
*third* room was selected. B's history was silently capped, with no way for the
user to tell why scrolling had stopped working.

The `.then` now matches the response against the room on screen before applying
anything. One comparison, because the room it was asked about is already in the
payload.

**I had this backwards, and the tests caught it before I wrote the fix.** Item
11 recorded that the fix "needs the response matched to the room it was asked
about, and the response does not carry one, so it is a backend shape question".
Two things were wrong with that. The response *does* carry it - `room` is in the
payload, and `test_recent_per_room_returns_its_room_and_the_message_authors`
(`chat/_tests/test_message_api.py:161`) already asserts it. And while checking
whether the unused `room` block could just be dropped, I found the endpoint
serializes it through the shared `RoomSerializer`, whose `get_last_message`
calls `remove_user_from_pending` - the same read-mutates-delivery-state problem
item 1 fixed in the export view, and I had a fix written for it.

It is not a bug. `test_viewing_a_room_acks_receipt_but_not_read` pins it on
purpose, with the comment *"fetching the room is the receipt ack; reading is a
separate explicit call"* - the transcribed design draws exactly that line
between received and read. So the backend is unchanged: the fix is one
comparison on the client, and the plan note that sent me looking was wrong.

**Verified by:** `tests/unit/room_paging_race.spec.js` - a late "nothing older"
from the chat you left does not cap the one you opened, and a current one still
caps its own. Watched fail first, on exactly the first test.

Mutation-checked: matching on `response.data.messages.length` instead of the room
fails the race test and passes the other, so the test is pinning the match and
not the empty array.

### 13. Every message sent left a 'seen' key behind forever (done)

The one item 10 spotted and deferred, on the grounds that clearing it safely
meant "deciding what an entry means for a message that is still in flight". That
decision was already in the code; I just had not looked for it.

`SendForm` commits `LINK_MESSAGES_TO_ROOM` **before** `ADD_MESSAGE_TO_SENDING`,
so the optimistic message misses the sendingPool branch and falls through to the
ordinary path, which registers its `front_key` in `state.receivedMessages`.
Nothing ever removed one. So every message a user sent kept a permanent
reactive entry describing a message that had long since arrived - and only
messages they *sent*, because the sendingPool branch never wrote a key at all.

**The sendingPool branch is the answer.** It fires exactly when the server's
copy has landed and been merged onto the same object: the moment a message stops
being in flight. That is where the key belongs no longer, and it is a line
beside the `sendingPool.delete` that branch already does.

**It is safe to drop the key, and that depends on item 9.** The `receivedMessages`
filter is a *pre*-merge check, so once the key is gone a repeat arrival reaches
`mergeMessages` - which dedupes on `front_key`, so the sender still gets one
bubble. Without item 9's dedup this change would have been a duplicate-render
regression; the test below exists to keep that dependency honest, and it fails
the moment the dedup is removed.

**Verified by:** two tests in `tests/unit/room_message_order.spec.js` - the key
is gone once the message is confirmed, and pruning it does not let the message
back in twice. Watched fail first on the first.

Mutation-checked: with `mergeMessages` keeping its sort but losing its dedup,
exactly the second test fails, which is the proof that it is not a vacuous
companion to the first.

**Deliberately not done:** entries for messages *received* still accumulate, one
per message, for the life of a session. Those do real work - they stop the
repeated `mergeMessages` call for a message already in the room - and pruning
them needs a policy (cap, or drop on room close) that nothing here asks for.
They are also proportional to what the store already holds: `roomMessages` keeps
every loaded message for the session regardless, with observers and all. The
entries this item removes were pure waste; the rest are bookkeeping.

### 14. Debug leftovers in shipped code (done)

Five `console.log` calls and a commented-out `catch`, all of them somebody's
mid-debug state that shipped:

- **`backend/csrf_token.js` logged the CSRF token on every page load.** It is
  read from a non-HttpOnly cookie - inherent to the pattern, not something this
  log caused - but logging it puts a live request-forgery token into console
  history, which outlives the page and turns up in screen shares, screenshots
  and tutorials. `CSRF_TOKEN` has exactly one consumer, `backend/index.js`, for
  the `X-CSRFTOKEN` header; nothing read the log.
- **`actions.js` `fetchSentInvitations`** logged both the whole axios response
  and `console.log("loieeeeeeeeee")` on failure, with the real
  `.catch(error => reject(error))` commented out directly above the noisy one.
  Someone was debugging that endpoint and never finished.

Deletion, so no test: the only check that means anything is the shipped artifact,
and it is checked there - `console.log` is now **0** in `bundle.js`, and the
header is still wired (`"X-CSRFTOKEN":xo`, with `xo` bound to the `csrftoken`
cookie read). `fetchSentInvitations` still rejects properly, so the unhandled
rejection is not a *new* risk - it is the pre-existing one, unchanged.

**Adjacent, not fixed:** `App.vue:77` `await`s `fetchSentInvitations` in
`created()`, with no `try`/`catch` around it. A failure there is an unhandled
promise rejection - the same class item 10 fixed for a send, and the same thing
that took the jest runner down before item 10's fix. It is a real defect, but it
is about what the app *does* on failure rather than leftovers, and the right
answer for a failed invitation list is a design question (silent, or a banner?)
that nothing here has settled.

### 15. Two stale copies of the settings module, committed (done)

`djchat/djchat/settings copy.py` and `djchat/djchat/asgi copy.py` - editor
backup files, committed alongside the modules they copy, neither ever edited
into sync:

- **`asgi copy.py`** is the draft from *before* the websocket app grew
  `AllowedHostsOriginValidator` and was wrapped in `ProtocolTypeRouter`. Its
  `"websocket"` branch is entirely commented out and it never routes sockets at
  all. The live `asgi.py` is a different file with different behaviour.
- **`settings copy.py`** still selects `channels_redis` with a **hard-coded
  password** - `redis://:Be6RO6BK...@redis-13637.c61.us-east-1-3.ec2.cloud.redislabs.com:13637/0`
  - where the live `settings.py` has been moved to `InMemoryChannelLayer` with a
  comment saying "the Redis host lives in your environment, not here". So this
  file was the last place in the tree holding that credential.

Nothing loads either one: `manage.py` sets `DJANGO_SETTINGS_MODULE` to
`djchat.settings`, no module anywhere in the project references `copy.py`, and
the names contain a space so they are not even importable as modules. Deleted
rather than kept, because a backup of a file whose live copy is the real one is
not documentation - it is a second, worse answer to "what does CHANNEL_LAYERS
look like here?", and this one says "paste the password in".

The credential is gone from the working tree and **still in git history**
(`f0bc74b update`, first commit of the file). Deleting a file does not unwrite
it, so that redis password should be treated as public and rotated. Same for
the `SECRET_KEY` literal in the deleted copy - it matches the literal the live
`settings.py` falls back to when `DJANGO_SECRET_KEY` is unset, and `problems.txt`
already insists on exporting a fresh one.

Deletion, so no test. Checked instead that it changes nothing: **200 pytest
passed**, `manage.py check` reports no issues, `makemigrations --check
--dry-run` reports no changes. `git rm`, so both files are recoverable from
history if they turn out to have been load-bearing after all.

### 16. One flaky fetch could cost you the whole socket (done)

Item 14 left this one named as "a real defect" and went no further, because it
looked like a design question. It is not - it is the same class as item 10, one
level up.

`App.vue`'s `created()` connected the socket on the **last line**, behind six
`await`ed dispatches. An awaited chain stops at the first rejection, so:

```
created() -> await fetchUserProfile      rejects
          -> the other five never run
          -> initializeWebSocketSupport() never runs
          -> this tab has no socket, for the rest of the session
```

One 500 from `/api/v1/me`, or one dropped request, or a server restarting
between two calls - and the app loads and looks fine while receiving nothing:
no new messages, no room or invitation updates, no read receipts. Nothing logs
it, and unlike a failed fetch a reload is no reliable answer, because the same
seven calls repeat every load and any one of them can be the one that fails.
`websocket_reconnect.spec.js` shows the two halves of the existing protection
did not help: the retry is armed by `onclose`, which never fires for a socket
that was never created, and the backoff starts from a `retryDelay` nothing set.

Fixed by moving one statement to the top of the hook, which is the whole fix
because the socket depends on none of the seven calls - it authenticates off
the session cookie, not off the profile. Also dropped the `await`: the method is
not async and returns `undefined`, so awaiting it was a no-op that read like a
wait. Three commented-out calls that item 14 would have caught went with it.

Two tests, plus a guard: the socket exists while the first fetch is still
pending; **no** one of the seven failing costs you the socket (each named in
the failure output, because "seven identical assertion failures" helps nobody);
and a clean load still connects exactly **one** socket - the obvious way to
break this fix is to connect eagerly *and* leave the trailing call in.

Mutation-checked both ways. Pre-fix, the two defect tests fail and the
double-connect guard passes. Re-adding a second `initializeWebSocketSupport()`
at the end of the chain fails **only** the double-connect guard - so it is
doing its job, and the other two are not passing by accident.

Rebuilt, because the bundle is what ships. The artifact carries it at
`case 0: return this.initializeWebSocketSupport(), t.next=3, this.$store.dispatch("fetchUserProfile")`
- first statement, ahead of all seven. Item 14's invariants survive the rebuild:
`onclose=function(){}` **0**, `console.log` **0**, `X-CSRFTOKEN` 1, `ws://` 1,
`retryDelay` 4, `fetchRoomActivity` 2, `SET_ROOM_ACTIVITY` 2. **34 jest passed**,
**200 pytest passed**, no migration drift.

**Not fixed, on purpose:** the remaining chain still aborts at the first
rejection, so a failed `fetchRooms` still means no rooms and a failed
`fetchMessages` still means an empty chat until reload. Those are visible, they
degrade to something the user recognises, and untangling six sequential awaits
into independent ones is a structural change to app load order for a class of
degradation that is already self-announcing. The socket was worth doing because
its failure mode is the one that is both silent and permanent.

### 17. The same defect, one function over - on the hot path (done)

Item 16 left `App.vue`'s `onmessage` handler untouched, and it carried the same
bug in the place that runs *every time somebody sends a message*:

```js
chatSocket.onmessage = async function(e) {
  ...
  await _this.$store.dispatch("fetchUnreadMessages");  // rejects
  await _this.$store.dispatch("fetchMessages");       // never runs
  EventBus.$emit("update");                           // never runs
```

Worse than item 16 in three ways. The two refreshes are **independent** - one
is the tab's unread count, the other is the messages themselves - so neither
should ever have been able to cancel the other, and there was no reason to
sequence them. Nothing awaits a WebSocket event handler, so the rejection had
no caller to reach: console noise in a browser, and under node it takes the
process down, which is how item 10 was found in the first place. And unlike the
load chain, the socket here stays open and healthy, so nothing ever triggers the
reconnect that might have papered over it - one failed fetch and the tab simply
stops rendering new messages.

Three more dispatches in the same handler - `fetchRooms` on `update_rooms`,
`fetchReceivedInvitations` on `update_received`, `fetchSentInvitations` on
`update_sent` - were fire-and-forget with no `catch` at all, so their failures
had the same nowhere to go. These are the room and invitation update paths, the
ones item 5 and item 7 were about.

Fixed at the call sites rather than in the store, and the line is worth stating
because it is what keeps item 10 working: **a failed send is fatal, a failed
background refresh is not.** `sendMessage` must reject, because its rejection is
what commits `REMOVE_FAILED_MESSAGE` and takes the optimistic bubble back down.
Making every action swallow its own failures in the store would have quietly
disabled that rollback. The difference belongs at the call site, where the two
kinds of dispatch are distinguishable.

So: five `.catch(ignoreFailure)` on the refreshes, the handler no longer
`async` because it no longer awaits anything, and a comment saying what is being
swallowed - the tab goes stale on a failed refresh, and the next push or
reconnect re-syncs it.

Two tests, and the second one is the interesting one. "A failed unread fetch
still fetches the messages" pins the ordering. "A failed refresh does not escape
the handler as an unhandled rejection" **observes** the failure rather than
inferring it: it records `process.on("unhandledRejection")`, fires all four
failing push types, and asserts nothing was reported. "No unhandled rejection"
is otherwise the one failure mode a passing test cannot see - pre-fix, jest
surfaced it as the test failing with `Error: offline`.

Mutation-checked with two isolating mutations, one per test, so neither was
passing for the other's reason. Dropping the `.catch` from `fetchRooms` alone
fails **only** the unhandled-rejection test. Re-gating `fetchMessages` behind
`fetchUnreadMessages` succeeding - handled, but only on success - fails **only**
the ordering test.

Rebuilt. The artifact carries `n.onmessage=function(e){...}` with all five
dispatches reading `.catch(r)` where `var r=function(){}`, and no `await` left in
the handler. Item 14's and 16's invariants hold: `onclose=function(){}` **0**,
`console.log` **0**, `X-CSRFTOKEN` 1, `retryDelay` 4. **36 jest passed**, **200
pytest passed**, no migration drift.

**Not fixed, on purpose:** `EventBus.$emit("update")` on line 36 has **no
listener anywhere** - `Invitations.vue` and `User.vue` listen, `update` does not.
It is inert, and now that nothing gates it, inert is all it is. Removing an event
hook is a different question from fixing a rejection, and an emit with no
listener is cheap enough to leave until something wants it.

**Adjacent, still bare:** the remaining fire-and-forget dispatches elsewhere -
`Invitations.vue` (accept / reject / cancel), `ReceivedMessage.vue` and
`SentMessage.vue` (`markMessageAsRead`), `MessagesSection.vue` (`markRoomAsRead`),
`ContactProfile.vue` (`deleteRoom`). All the same shape, all silent on failure,
none of them on a path where the failure wedges the tab the way these two did.
Left for a decision rather than a sweep - and the decision, taken item 18 below,
was **no**: every one of them leaves state unchanged and retryable, which is
behaviour, not breakage. A failed `markRoomAsRead` leaves the badge showing, and
the badge is what the user clicks again with. Only the socket cases were defects,
because only they failed silently *and* permanently.

### 18. The one place that described a failure could not describe one (done)

Hunting for the item-17 shape elsewhere found something better than another
unguarded dispatch. `InvitationModal.vue` - item 7's file, the "add a friend"
modal - does everything right around its two dispatches: each in its own
try/catch, each with a specific message for a specific status code. And then
both catch blocks open with:

```js
if (error.response.status === 404) {   // ... and the same for 400
```

Axios only sets `response` when the server **actually replied**. Anything that
stops a request short of a reply leaves it undefined. Verified against the
installed axios rather than remembered:

```
code        : ECONNREFUSED
e.request   : true
e.response  : undefined
=> e.response.status throws: TypeError
```

So the line whose whole job was to describe the failure threw a `TypeError`
*inside the catch block*. That meant `this.error` was never assigned - the only
place it is ever assigned is inside those catches - and the `TypeError` escaped
`addFriend()` as an unhandled rejection. The user pressed Send, the server was
down, and the modal showed **no error at all**: no message, no shake, nothing to
say the request had failed. The one screen where the next action is to press
Send again, failing silently.

This is item 8's defect - "a failed profile save said nothing" - reached by the
one path item 8's fix does not cover. `UserProfile.vue` (item 8) fixed its
catch and, correctly, does not inspect the error at all, so it was never
affected. These two lines are the **only** `error.response` dereferences in the
frontend, so this was the only place the pattern could bite.

Fixed with a guard, twice. Deliberately **not** `error.response?.status`: this
is webpack 4 on acorn 6 and optional chaining is not parseable, which is also
why the codebase uses `&&` guards throughout and has no `?.` anywhere. Verified
after the fact - the bundle contains zero unguarded `.response.status` and two
guarded forms, `t.t0.response&&404===t.t0.response.status` and the same for 400.

Five tests. The two defect tests assert the method **resolves** as well as
producing the generic message, because pre-fix it rejected with the TypeError -
`await expect(...).resolves` fails on that alone, which is a clearer report than
the text mismatch would have been. The 404 and 400 tests are guards against
"fixing" the dereference by throwing the detail away. The fifth pins that a
failed send leaves the modal open, since closing is what `addFriend` does on
success.

Mutation-checked one catch block at a time, since both fixes are one short
expression and either could have been the load-bearing one. Undoing the 404
guard fails **only** the first test. Undoing the 400 guard fails the second and
the fifth - the fifth is not an independent guard, it reaches the same second
catch, and it is worth saying so rather than counting it as one.

Rebuilt. **41 jest passed** (36 -> 41, 7 -> 8 spec files), **200 pytest passed**,
no migration drift. Item 14/16/17's invariants hold: `onclose=function(){}` **0**,
`console.log` **0**, `X-CSRFTOKEN` 1, `retryDelay` 4.

### 19. "Delete chat" reported nothing either way (done)

Item 17 listed five bare dispatches and said they needed a decision. Item 18
decided against sweeping them: all five leave state unchanged and retryable.
Applying that to `ContactProfile.vue:146-151` turned out to be the wrong call for
one of them, and it is worth saying so rather than letting the generalisation
stand.

```js
deleteChat() {
  const roomId = this.getRoom.id;
  this.$store.commit("SET_SELECTED_ROOM", null);
  this.$store.dispatch("deleteRoom", roomId);   // bare
  this.$emit("toggleRightSidenav");            // unconditionally, on click
}
```

Both side effects ran **synchronously on click**, before the server had been
asked anything. So a delete that failed was completely invisible: the chat
closed, the panel slid away, the room stayed in the sidebar, and nothing said any
of that had happened. No error, and the rejection had nowhere to go either.

That makes it different from the other four, and the difference is not severity -
it is that this one has **no outcome signal at all**. A failed `markRoomAsRead`
leaves a badge showing; the badge *is* the report. A failed delete leaves an
empty-looking sidebar that the user has to reload to notice was never deleted,
which is a destructive action with no confirmation of any kind.

The panel closing is the part that had to move, and it is the reason a plain
`.catch()` would not have been a fix. The natural place to render a message is
inside this panel, and the panel was being closed on click - so any error text
would have slid off screen unread. The close is not a side effect of deleting;
it is the thing that made the failure unreportable.

Fixed by moving **both** side effects into the success path: on success the end
state is exactly what it was, a beat later. On failure nothing moves - the room
is still there, still clickable, so there is nothing to undo - and the panel
stays open carrying the message. Nothing needed undoing is the reason this is
three lines rather than a rollback.

One thing the tests forced, which is a fix and not a test accommodation:
`deleteChat` **returned `undefined`**. A method that starts a promise and hands
back nothing can be neither awaited by a caller nor tested at all, and the two
tests that check the failure path failed with `error: ""` because `await
undefined` resumed a microtask before `.catch` had run. Returning the chain is
what made the behaviour observable, and no caller changes either way - the click
handler ignores a return value.

Five tests, and **four isolating mutations**, one per assertion, because each
is one short expression and any of them could have been doing the work:

| mutation | fails only |
|---|---|
| `$emit` back to synchronous | "says so instead of closing the panel" |
| error line removed from the template | "says so instead of closing the panel" (`toContain`, line 57) |
| `error = ""` dropped from the success path | "retrying clears the error once it works" |
| `SET_SELECTED_ROOM` back to synchronous | "a failed delete leaves the chat open and selected" |

The template mutation is the one worth having: it separates "`error` is set" from
"`error` is on screen", which is precisely the distinction this bug was about.

**Honest limit on the evidence:** pre-fix, this spec **killed the node process**
- the bare dispatch rejecting into nowhere, item 10's failure mode - so the suite
could not serve as a baseline and the four assertions past the first were never
observed failing against the old code. They were confirmed non-vacuous by
mutation instead, which is weaker than watching a test fail and is recorded as
such. The stack trace naming `ContactProfile.vue:152` is the pre-fix evidence
that exists.

Rebuilt; the artifact carries
`dispatch("deleteRoom",e).then(...error="",commit,"toggleRightSidenav").catch(...error="The chat could not be deleted...")`.
**46 jest passed** (41 -> 46, 8 -> 9 spec files), **200 pytest passed**, no
migration drift. Invariants hold: `onclose=function(){}` **0**, `console.log`
**0**, `X-CSRFTOKEN` 1, `retryDelay` 4.

**Not fixed, on purpose:** there is still no confirmation *before* deleting. The
row is one click and the action is irreversible. That is a UX decision rather
than a defect - the app does not confirm destructive actions anywhere - so it is
recorded, not built.

### 20. One failed load fetch could bring up an empty app (done)

Item 16 moved the socket off the end of the `created()` chain and explicitly
deferred the rest of it: *"the remaining chain still aborts at the first
rejection, but that is visible - the failed fetch is the one you see."*

That reasoning was wrong, and checking it is what overturned it. `router/index.js`
has one route and no `beforeEach`; `main.js` registers no guard; nothing on the
frontend handles an auth failure. And `fetchUserProfile` is **first** in the
chain. So an expired session - a 401 on the single request at the top - did not
produce partial data, it produced a completely empty app: no rooms, no messages,
no invitations, and no error, no redirect, no retry. "Visible" was a thing I
assumed rather than checked.

```js
await this.$store.dispatch("fetchUserProfile");      // 401 -> everything below
await this.$store.dispatch("fetchSentInvitations");  // never runs
await this.$store.dispatch("fetchReceivedInvitations");
await this.$store.dispatch("fetchRooms");
await this.$store.dispatch("fetchUnreadMessages");
await this.$store.dispatch("fetchMessages");
await this.$store.dispatch("fetchRecentActivity");
```

Six `await`s in a row, each reachable only if all the ones above it succeeded.
Fixed with `Promise.all` over the same seven dispatches. Dropping the order is
safe: item 9 made every merge into the store order-independent by keying on id
and recomputing counts, so these were never waiting on each other's *results*,
only on each other's *timing*.

`Promise.all` and not `Promise.allSettled`, and the difference matters even
though no test can see it. `allSettled` never rejects, so the 401 would become
completely silent - the exact failure this item exists to remove. It is also a
static method babel-preset-env cannot polyfill (it is not syntax), so it would
be a `TypeError` on any browser without it. `Promise.all` also still propagates
the first rejection out of `created()`; that leaves an unhandled rejection, which
is the same trade items 14, 16 and 17 made - visible beats silent.

Two tests, and **three mutations**, two of which isolate the pair from each
other:

| mutation | fails only |
|---|---|
| drop `fetchMessages` from the array | both |
| back to a serial chain, each with `.catch(() => {})` | "every load fetch starts without waiting" |
| `Promise.all` -> `Promise.allSettled` | **nothing** |

The second row is the one worth having. Per-dispatch `.catch(ignore)` is the
obvious fix and it *works* for the reported symptom - every fetch is issued even
when one fails, so the empty app is gone and the first test passes. It still
serialises: a request that never comes back holds the other six indefinitely,
which is the second test. Two tests, because one assertion cannot distinguish
"nothing cancelled anything" from "nothing waited for anything".

The third row is an honest limit rather than a gap I intend to close. `allSettled`
passes all 48, and should - the difference is in what the code refuses to do, not
in what it does, so no behavioural test can separate them. The argument for
`Promise.all` is the paragraph above.

**A limit on the tests themselves, worth recording:** the first version of the
"starts without waiting" test used a `setTimeout`-based `settle()`, which the
file's `beforeEach` fake timers made un-callable - it failed as a 5s **timeout**,
proving nothing about the production code. It now settles on `setImmediate`,
which fake timers do not replace. A test that fails for want of a clock is
indistinguishable from a test that fails for the right reason, and the difference
is only visible in the failure message.

Rebuilt; the artifact carries
`Promise.all([...dispatch("fetchUserProfile")...dispatch("fetchRecentActivity")])`
with `initializeWebSocketSupport()` still first and still not awaited.
**48 jest passed** (46 -> 48), **200 pytest passed**, no migration drift.
Invariants hold: `onclose=function(){}` **0**, `console.log` **0**,
`X-CSRFTOKEN` 1, `retryDelay` 4.

**Not fixed, on purpose:** a 401 now leaves the rest of the app loaded and
correct, but nothing *tells* the user their session expired. The data on screen
will simply be whatever the six other requests returned. Handling that is a real
feature - an auth interceptor, a sign-in redirect - and it is the user's call
whether to have one, not something to smuggle in with a `catch`.

### 21. A plus-addressed friend could never be invited (done)

The invite flow resolves an email to an account to get a user id:

```js
getUserIdFromEmail(none, email) {
  axios.get(`/api/v1/users?email=${email}`)   // email is whatever the user typed
```

`email` is typed by the user and dropped into a query string with no encoding.
In a query string `+` means space, and the browser does not re-encode it - the
`+` goes over the wire as a `+` and the server decodes it to a space. So
`bob+chat@gmail.com` is looked up as `bob chat@gmail.com`, matches nothing, and
comes back 404, and the modal says **"User not found."** for an address that is
registered. That is the worst kind of failure here: wrong, but completely
convincing, and silent about the real cause.

Plus-addresses are ordinary, not exotic - `bob+chat@gmail.com` is how Gmail
aliases work and Fastmail hands them out by default - so this is a real,
registered user who simply cannot be invited. Confirmed end to end: Django's
`request.GET` does decode `+` as a space (checked against the actual query
parser), and the endpoint matches on the exact address.

This is the only one of the three interpolated query strings where user input
reaches a URL; the other two interpolate a message id and an offset, both
numbers the app produced itself. So the fix is one line, at the one site:

```js
axios.get(`/api/v1/users?email=${encodeURIComponent(email)}`)
```

Three jest tests and one pytest, because it is a client/server pair and the two
halves fail independently. The jest tests pin the URL axios was asked for; the
pytest pins that Django decodes `%2B` back to the stored address. Neither alone
proves the round trip, and that is the point - the sibling backend tests pass the
address as a dict, which the test client encodes for you, so they only ever
covered the half that already worked.

Four mutations, all of which fail the intended test:

| mutation | fails |
|---|---|
| `encodeURI` instead of `encodeURIComponent` (leaves `+`, `@`, `/`) | both jest URL tests |
| `encodeURIComponent` applied twice | both jest URL tests |
| backend query sent raw (`dave+chat@gmail.com`) | the pytest (404) |
| drop `encodeURIComponent` entirely | both jest URL tests |

**Honest limit on the evidence, twice over.** First, a bug of my own making, and
the more useful of the two: the "plain address" test initially failed for the
*wrong* reason - `requestedUrl()` read `calls[0]`, still the previous test's
call, because the mock was never cleared. It failed either way, but it was not
proving what it claimed. `mockClear()` in a `beforeEach` is now what makes the
two tests independent. Second, the fix is verified at the URL and at the HTTP
status, not by clicking through a real plus-address invitation in a browser; the
two halves are each pinned, but nothing here drives the actual UI.

Rebuilt; the artifact carries
`api/v1/users?email=".concat(encodeURIComponent(e)`. **51 jest passed** (48 -> 51,
9 -> 10 spec files), **201 pytest passed** (200 -> 201), no migration drift.
Invariants hold: `onclose=function(){}` **0**, `console.log` **0**,
`X-CSRFTOKEN` 1, `retryDelay` 4.

**Not fixed, on purpose:** the modal still answers "User not found." for any
address that does not resolve, including a genuinely mistyped one. That is the
correct message for that case, so changing it would be wrong - the defect was
never the wording, it was that a *valid* address was being turned into an
invalid one before it left the browser.

### 22. Every room row ever created stayed subscribed to the EventBus (done)

`User.vue` is one sidebar row per chat, and it subscribes in `created()`:

```js
created() {
  EventBus.$on("writing", data => {
    if (this.room.id === data.room_id) {
      let user = this.$store.state.users[data.user_id];
      this.whosWriting = user.username;
```

Two defects in one subscription.

**It is never removed.** Nothing in the tree calls `$off` - the only cleanup in
the codebase is `WindowSize`'s resize listener, so the pattern was known and
simply not applied here. `UsersSection` renders a `v-for` of these keyed by
room id, so every room that is added and then removed destroys a `User` and
leaves its listener subscribed, holding the dead component and its store
reference for the rest of the session. "Delete chat" is a one-click action that
lands here, so this is on the ordinary path, not an edge case.

**And `user.username` is read unguarded.** `state.users` is empty for the first
seconds of every session, because the socket connects *before* the first fetch
resolves - which is items 16 and 20 working as designed. A peer who starts
typing while you are still loading sends a `writing` push naming a user the
store has not seen, and that line throws a TypeError inside a WebSocket event
handler. So this defect was created by an earlier fix and only became reachable
once the socket stopped waiting on the fetches.

Fixed by moving the handler to `methods` (an inline arrow has no stable
reference for `$off` to give back), pairing it with `beforeDestroy`, and
guarding the lookup. Four tests and **two isolating mutations** - one per
defect, each failing exactly one test:

| mutation | fails only |
|---|---|
| `user ? user.username : ""` back to `user.username` | "a writing push for an unknown user does not throw" |
| `beforeDestroy` renamed out of the way | "a removed room row takes its listener with it" |

The second is worth having: `$off` being *called* and the listener actually
being *gone* are different claims, so the test asserts both.

**Two honest limits, and both are about my own tests rather than the fix.** The
first version of the crash test used `expect(() => ...).not.toThrow()`, and it
passed straight through the TypeError it was written to catch - Vue catches
handler errors, logs them and carries on, so the throw never reaches the
`$emit` caller. `Vue.config.errorHandler` is where the caught error actually
goes. The second: the `$off` spy was written `jest.fn(off)` where `off` was
itself a no-op mock, so the spy recorded the call while deregistering nothing,
and the test passed for a reason that had nothing to do with the code. Both are
recorded because a test that fails to fail is worse than no test - it is a green
tick that will hold after the next refactor breaks it.

Rebuilt; the artifact carries exactly one `$on("writing"` and one
`$off("writing"`. **55 jest passed** (51 -> 55, 10 -> 11 spec files),
**201 pytest passed**, no migration drift. Invariants hold:
`onclose=function(){}` **0**, `console.log` **0**, `X-CSRFTOKEN` 1,
`retryDelay` 4.

**Not fixed, on purpose:** a push naming a user the store has not seen now shows
nothing rather than a name, and the typing indicator stays silent until that
user arrives in `state.users` by some later fetch. That is the honest
behaviour - there is no name to show - and closing the gap properly means
resolving the id against `/api/v1/users/`, which is a new endpoint and a new
request on a path that fires on every keystroke.

### 23. A second, broken chat UI at `/chat/` (done)

`djchat/urls.py` carried one line that served a whole application nobody uses:

```python
# Django Websockets
path('chat/', include('chat.urls')),
```

routing `GET /chat/` to `chat.views.room`, which rendered
`chat/templates/chat/room.html` - the page the Channels tutorial ships. The Vue
app replaced it, and a grep for `/chat/`, `chat/urls`, `views.room` and
`views.index` returns only the definitions themselves: no link, no test, no doc.

Three defects, all of them in the template.

**It cannot open its socket.** `room.html` hardcodes
`new WebSocket('ws://' + window.location.host + '/ws/notifications/')`, and
`problems.txt` starts this app as `daphne -e ssl:443`. A browser on https blocks
`ws://` as mixed content, so the socket never opens. That is item 16's
hardcoded-scheme defect in a file no frontend test could reach - jest mounts
components, not templates.

**It discards what you type.** The Send button calls `chatSocket.send(...)`, and
`ChatConsumer` has **no `receive` handler at all**, so the payload is accepted
by the browser and dropped by the server. The page looks like it works: the text
lands in the textarea, because `room.html` appends it there locally, and nothing
ever comes back.

**It renders to anyone.** `views.room` has no `LoginRequiredMixin`, so unlike
every other page in this app it serves an anonymous visitor -
`IndexTemplateView` is `LoginRequiredMixin`, and `core/_tests/test_entry_point.py`
pins `/` redirecting to `accounts/login/`.

`views.index` and `chat/index.html` were already unreachable: `chat/urls.py`
bound only `views.room`, so nothing ever rendered them.

Deleted with the route, rather than left behind: **`chat/_tests.py`**, the
tutorial's own Selenium test for that page. It cannot run - pytest's
`python_files = test_*.py *_test.py test.py` (`pytest.ini:6`) never matches
`_tests.py`, and pointing pytest at it directly errors on a module-name collision
with the `chat/_tests/` package. It drove `#chat-log` and `/chat/`, and its
`find_element_by_css_selector` was removed in Selenium 4 (the venv has 4.50.0).
A test for a page that no longer exists can only ever fail.

**`chat/routing.py` is live and was not touched**: `ws/notifications/` is the
route `App.vue` actually connects to.

The fix is one line and five files - 189 deletions. `/chat/` now falls through
to the existing catch-all `re_path(r"^.*$", IndexTemplateView.as_view())` like
every other unmatched URL, which makes it an ordinary client-side route into
the SPA.

**A third test was written, watched fail, and then deleted as redundant.**
`assert b'chat-log' not in content` is strictly implied by the byte-identity
assertion below: if the path resolves to the entry point, the body *is* the SPA
shell, and the shell contains no `chat-log`. Anything the string check catches,
byte-identity catches too - and byte-identity additionally catches *any* other
wrong page at that path, which a string check cannot. It was a negative
assertion about a string that no longer exists anywhere in the repo.

**Two isolating reversions**, and the second is the one worth having:

| reversion | result |
|---|---|
| restore the route exactly as committed | all tests fail |
| restore it **with `LoginRequiredMixin` on `views.room`** | the redirect test **passes**, byte-identity still fails |

The second shows the two surviving tests are independent claims. Fixing the auth
hole alone does not make `/chat/` correct - the page is still the broken tutorial
page for a signed-in user, which is exactly the case the byte-identity test
holds and the redirect test is blind to.

**203 pytest passed** (201 -> 203), no migration drift. The frontend is untouched
by this item, so the bundle and its **55 jest** are unchanged. A repo-wide grep
for `chat-log`, `views.room`, `views.index` and `chat.urls` now returns only this
item's own prose.

**Honest limit:** this removes a public URL. Anyone who had bookmarked `/chat/`
now gets the SPA instead of a textarea - which is what every other URL in the
app already gives them. It strictly narrows the unauthenticated surface; nothing
becomes newly reachable, and it is fully reversible from git.

### 24. The invite modal said "User not found." for the rest of the session (done)

`InvitationModal.vue` holds two pieces of `data` that nothing ever resets.
`this.error` is assigned in exactly two places, both `catch` blocks, and
`open()` / `close()` only flip `showModal`:

```js
open() {
  this.showModal = true;
},
```

`Home.vue:11` mounts the modal with no `v-if`, so that component instance lives
for the whole session.

The path is ordinary:

1. Type `bob@gmial.com` - a typo - and press Send. "User not found."
2. Notice the typo, fix it to `bob@gmail.com`, press Send. The invitation is
   sent and the modal closes. Everything so far is correct.
3. Press Send a minute later to invite someone else. The modal opens on the
   previous address, with **"User not found." still under it** - an error about
   an address that is no longer in the box, for a lookup nobody has attempted.

`friendEmail` is never cleared either, so step 3 starts pre-filled with someone
who has already been invited. Pressing Send on that comes back "You have
already sent an invitation." for a person who was never asked for anything.

This is items 8 and 18 one layer over. Those fixed a failure that reported
*nothing*; this is a failure that reported something and then never stopped. The
one screen whose entire purpose is "type an address, get an answer about that
address" is the one screen that will still be answering about the last address
after you have replaced it.

Three lines, each on a path that reaches it: reset `error` at the top of
`addFriend()` (before the request, not on failure - a stale message has to be
gone *before* the next attempt or it reads as the answer to the Send just
pressed), clear `friendEmail` on success, and reset both in `open()`.

**Not in `close()`.** There is a Close button, and the overlay behind the modal
dismisses it too, so a half-typed address has to survive a dismissal. Clearing
belongs to `open()` and to success. One test exists purely to hold that line.

**Three isolating mutations**, one per line of the fix, each failing exactly one
test:

| mutation | fails only |
|---|---|
| `this.error = ""` removed from the top of `addFriend` | "an error does not survive a later success" |
| both resets removed from `open()` | "opening the modal clears a message left by an earlier attempt" |
| `this.friendEmail = ""` removed from the success path | "a sent address does not come back when the modal is reopened" |

The "second failure replaces the first" test failed for the wrong reason on its
first run and is worth recording: one `addFriend()` attempt dispatches **twice**
- `getUserIdFromEmail`, then `addFriend` - so a positional mock script puts the
second failure on the *lookup* and the 400 lands in the wrong catch. It was
keyed by action instead. A test that fails to fail for the stated reason is
worse than no test.

Rebuilt; the artifact carries the fix. **60 jest passed** (55 -> 60, 11 -> 12
spec files), **203 pytest passed** (unchanged - this is a frontend-only item),
lint clean. Invariants hold: `onclose=function(){}` **0**, `console.log` **0**,
`X-CSRFTOKEN` 1.

**Honest limit:** the reset is local to this component. The same "nothing clears
it" pattern is worth a look elsewhere, and the look found one - item 25. Each is
its own fix with its own tests; bundling them would have made three mutations
indistinguishable.

### 25. "Delete chat"'s failure message followed you to another chat (done)

Item 19 moved the panel close and the room deselect into the success path of
`deleteChat()`, so a refused delete says so instead of looking like it worked.
That covers repeated attempts **on the same chat**. It does not cover the
message following you somewhere else.

It does, because the profile panel is not re-mounted per room:

- `Rooms.vue:8` passes `:rightSidenav="rightSidenav"` straight through, and
  `ContactProfile` renders from `$store.state.selectedRoom` in every computed,
  so the whole panel rebinds to the new room *in place*.
- `UsersSection.selectRoom` commits `SET_SELECTED_ROOM` and emits
  `selected-room`; `Home.vue`'s `openMobileRooms` only opens the mobile drawer.
  Nothing flips `rightSidenav`.
- On desktop (`Home.vue:45`, `width >= 768`) the sidebar and the panel are both
  on screen, so this is one click, not a gesture.

So: open Bob's profile, press Delete chat, the server refuses. The panel stays
open and reads "The chat could not be deleted. Please try again." Click Carol in
the sidebar. Same panel - now showing **Carol's** name, tagline and activity
chart - still carrying the sentence from Bob's failed delete, above **Carol's**
Delete button.

**The panel already had this guard, one field up.** `getActivity` explicitly
refuses to draw the previous room's bars under the new room's name:

```js
if (!activity || activity.room_id !== this.getRoom.id) return null;
```

and `activityLoaded` is reset when the panel opens. That is the same defect
class, found and fixed for the chart and missed for the error message - the one
thing on the panel that does not belong to the room currently shown. Four lines:

```js
roomId() {
  this.error = "";
},
```

The name is the point. This watches the room **id**, not `getRoom`, and the
reason is specific: `SET_ROOMS` does `Vue.set(state.rooms, element.id, element)`,
so every `fetchRooms` replaces each room's entry with a **fresh object literal**
- and `App.vue` dispatches `fetchRooms` on any `update_rooms` push. A watcher on
`getRoom` therefore sees a new object identity for the *same* room, fires, and
takes the message down mid-attempt. The id changes only when the user actually
picks another chat.

**Two isolating mutations**, and the second is the one that pins the form of the
fix:

| mutation | fails only |
|---|---|
| `error` assigned inside the success path of `deleteChat` only, pre-fix | "a failure on one chat is not reported on another" |
| watcher moved onto `getRoom` instead of `roomId` | "the same room refreshed in the store does not clear it" |

**The fourth test was rewritten, and the first version proved nothing.** It set
`state.roomActivity` and asserted the message survived - reasoning that a fresh
`{}` from a computed watcher "for every write" would clear it. It passed against
*both* watchers. Vue caches computeds, and `getRoom` depends on `selectedRoom`
and `state.rooms`, not on `roomActivity`, so nothing re-evaluated at all. The
test now sets `state.rooms` to a fresh object, which is what `SET_ROOMS` actually
does. A test that fails to fail is worse than no test; the reason it failed to
fail was worth more than the test.

Rebuilt; the artifact carries the fix. **64 jest passed** (60 -> 64, 12 -> 13
spec files), **203 pytest passed** (unchanged - no backend file was touched),
lint clean. Invariants hold: `onclose=function(){}` **0**, `console.log` **0**,
`X-CSRFTOKEN` 1, `encodeURIComponent` 5.

**Honest limits:** this reacts to a genuine room change and deliberately not to
an unrelated store write, so a `SET_ROOMS` refresh arriving *while* a delete is
in flight leaves the message up - correct, since the room did not change. And
like item 24 it is component-local: the same "nothing clears it" shape in a third
component would be a third item, not a pattern this one generalises to.

### 26. A development socket-test page shipped in the served static tree (done)

`frontend/public/test.html` was a hand-rolled page whose entire content was:

```js
const socket = new WebSocket('ws://localhost:8080/ws/notifications/')
console.log(socket)
```

Nothing links to it. Grep across every `.py`, `.js`, `.vue`, `.html` and
`.json` in the repo returns zero references. It was still publicly served,
because `frontend/public/` is a **copy list** rather than a source list -
`vue-cli-service` copies it into the output verbatim instead of bundling it,
and `WHITENOISE_USE_FINDERS = True` makes all of `static/` public with `DEBUG`
off, which is the configuration `problems.txt` deploys. Verified by probe
before the fix: `GET /static/dist/test.html` returned `200`, a
`WhiteNoiseFileResponse`, 390 bytes, containing `localhost:8080`. After the
fix it returns `302` - it falls through to the catch-all like any other URL
the app does not claim.

**Why item 14's debug sweep did not catch it.** That swept `bundle.js` for
`console.log` and a swallowed `onclose`. `public/` files are not *in*
`bundle.js`, so nothing that reads the bundle can see them. This is the
inverse of the tests already in `test_entry_point.py`, which walk the static
URLs the page *references* - `test.html` is referenced by nothing, which is
exactly what makes it invisible there.

**Two tests, because the two directories fail separately.** Deleting the file
from `public/` without rebuilding leaves the served copy in place, and
`problems.txt` already records that the deploy never rebuilds - so the source
is clean and the defect is still reachable. That is the same trap every
frontend fix in this branch fell into before the bundle was rebuilt, and here
the build is the only thing that removes the file.

The marker is `WebSocket(` **and** `localhost`/`127.0.0.1`, not either one.
`App.vue` legitimately builds a WebSocket, so "opens one" would condemn the
whole app; what makes a page a development artifact is that its socket points
at the machine it was written on.

| mutation | fails only |
|---|---|
| `frontend/public/test.html` restored, served copy still gone | "the public directory holds no development scratch page" |
| `static/dist/test.html` restored, source clean | "the served bundle directory holds no development scratch page" |

Both were run and isolated. **205 pytest passed** (203 -> 205), **64 jest
passed** (unchanged - this is a static-asset item), lint clean, bundle rebuilt
and the file absent from `dist/`.

**Honest limits:** the check finds scratch pages, not every kind of stray
file - a debug page that does not open a socket would pass it. And it reads
the working tree, so it is a statement about what is committed rather than
about what a user can request; the 200-vs-302 evidence above is from a live
request and is not pinned by a test.

### 27. A draft you wrote for one chat was sent to another (done)

Found by a parallel read-only sweep of the frontend, then traced and reproduced
here rather than taken on the agent's word.

`<send-form />` sits at `Rooms.vue:22` with no `:key` and no `v-if`, and `Rooms`
is mounted once by `Home.vue:46` - so there is exactly **one SendForm instance
for the whole session**. Its `room` watcher was:

```js
room() {
  this.timerId = null;
}
```

The throttle is cleared; the text is not. `body` is written in four places
(`data()`, the v-model, `sendMessage()`, and the refusal catch) and the watcher
is none of them.

1. Bob's chat is open. You type "see you at 8" and do not press Enter.
2. You click Carol. The header, avatar and `ContactProfile` all rebind to
   Carol - and `sendMessage` reads `this.room`, a computed on
   `$store.state.selectedRoom` (`SendForm.vue:88`), which is now Carol's id.
3. You press Enter. The POST carries `{room: carol, body: "see you at 8"}`.

Bob never sees it. Carol gets a message written for Bob, rendered green in
Carol's thread as an ordinary sent message. **Of everything the sweep turned up,
this is the one that puts text in front of the wrong person.**

Reproduced before fixing it, not assumed: with the watcher untouched, the
dispatch payload's `room` came back as `8` - Carol - for a draft typed against
Bob's `7`.

The second half is the same defect from the other end. A refusal takes a round
trip, and the existing guard is only `if (!this.body)`. By the time the catch
runs, the box is empty (the send cleared it, and the watcher clears it again),
so the guard does not stop anything: the failed message's text arrives in the
*new* chat's box, and the next Enter sends it there. So the catch now asks which
chat it sent to.

**Two isolating mutations**, each failing exactly one test:

| mutation | fails only |
|---|---|
| `this.body = ""` removed from the `room` watcher | "a draft composed for one chat is not sent to another" |
| `&& this.room === sendingMessage.room` removed from the catch | "a refusal that lands after you switched chats does not come back" |

Both were run and isolated. The second test deliberately sends *before* switching
rooms, so the box is already empty when the room changes - it pins the catch's
guard on its own and does not lean on the watcher. A third test is the over-fix
guard: a refusal in the *same* chat still restores the text, because reducing
the guard to "clear and never restore" would throw away every unsent message.
`failed_send.spec.js` cannot catch that - it never switches rooms.

Rebuilt; the artifact carries the fix. **67 jest passed** (64 -> 67, 13 -> 14
spec files), **205 pytest passed** (unchanged - no backend file was touched),
lint clean. Invariants hold: `onclose=function(){}` **0**, `console.log` **0**,
`X-CSRFTOKEN` 1, `encodeURIComponent` 5.

**Honest cost of the second fix:** a message that fails *and* whose chat you
leave in the same round trip is now lost rather than misdelivered. That is the
trade I would make - misdelivery is worse - but it is a real loss. Per-room
drafts would keep it, and that is a feature rather than a fix, so it is not
here. Also unfixed, and both from the same sweep: `Invitations.vue:118-126`
drops the promise on accept/reject/cancel with no `.catch` and no local commit,
so a refused request leaves the row and the tab badge exactly as they were with
no message anywhere; and a message body over 500 characters is unsendable and
blinks out silently, because `TextField(max_length=500)` becomes a serializer
cap while `SendForm` has no `maxlength` and no error display - the same defect
`UserProfile.vue` already fixed for the tagline.

### 28. A message over 500 characters was typable but unsendable (done)

`chat.models.Message.body` is a `TextField(max_length=500)`. The database
ignores `max_length` on a `TextField` - it is a no-op there - but DRF's
`get_field_kwargs` copies it onto the serializer field regardless, so
`CreateMessageSerializer` validates `body` as `CharField(max_length=500)`.
Measured against a live request rather than assumed:

```
500 chars -> HTTP 201
501 chars -> HTTP 400 {"body": ["Ensure this field has no more than 500 characters."]}
```

`SendForm`'s input had no `maxlength`, and the component has no way to show an
error at all. So:

1. Type or paste 501 characters, press Enter. `sendMessage` commits the
   optimistic bubble and clears the box.
2. The 400 comes back. `store/actions.js` commits `REMOVE_FAILED_MESSAGE`, and
   the catch puts the text back.
3. The bubble blinks out, the text reappears, and nothing says why. Pressing
   Enter again mints a fresh `front_key` and fails identically - **there is no
   action the user can take that sends it.**

**This project already fixed this exact defect once**, for the other
length-limited field. `UserProfile.vue:113-118` added `maxTagline: 1024` with a
comment naming the failure ("a paste over the limit came back as a 400 that
nothing displayed"). `body` never got the same treatment, so the fix is the
one already in the tree:

```js
maxBody: 500
```

```html
:maxlength="maxBody"
```

**Three tests, because the number lives in two places.** The frontend cannot
import the model, so the cap is duplicated - and it drifts silently in both
directions. Above the server's cap reproduces the bug outright; below it quietly
denies the user room the server would have taken.

| mutation | fails only |
|---|---|
| `:maxlength="maxBody"` removed from the input | "the input will not accept a message the server will refuse" |
| `maxBody` drifted 500 -> 499 | **`test_the_client_cap_matches_the_body_limit`** - jest stays green |

The second row is the one worth keeping. Under an off-by-one, **both jest tests
pass** - the attribute matches its own constant, because that is all they can
see - and only the Django test fails, with `assert 499 == 500`. That is the
whole argument for the cross-half test existing.

That test reads `SendForm.vue`'s source rather than the built bundle, on
purpose: `dist/` is a build artifact that goes stale, and every frontend fix in
this branch was a no-op until `npm run build` ran. Asserting against `dist/`
would have passed against a bundle nobody had rebuilt.

Rebuilt; the artifact carries the fix (`maxBody` present twice in `bundle.js`).
**69 jest passed** (67 -> 69, 14 -> 15 spec files), **207 pytest passed**
(205 -> 207), lint clean. Invariants hold: `onclose=function(){}` **0**,
`console.log` **0**, `X-CSRFTOKEN` 1, `encodeURIComponent` 5.

**Honest limits.** `maxlength` silently truncates an over-long paste, which is a
small dishonesty traded for making the message sendable - the tagline fix
accepted the same trade. And `max_length=500` on a `TextField` is an arbitrary
cap the database never enforced: WhatsApp allows far longer, so raising it is a
product decision that comes with a migration, and migrations are yours.

### 29. Accepting an invitation left the accepter's own Sent tab pointing at a
row that no longer existed (done)

Item 18 listed five bare dispatches and declined to sweep them, on one ground:
*they leave state unchanged and retryable, which is behaviour, not breakage.*
That reasoning is right for four of the five and wrong for `Invitations.vue`'s
three, and this is the case that shows it.

The screen is reachable in three steps and needs no unusual data. Two people
invite each other - `can_request_send` (377) only looks one way down, and
`unique_together` is on the *ordered* pair, so the cross-invite is a legal state
the UI offers on its own. Then one accepts.

`accept()` (110) deletes the accepted row **and** its reverse, and busts both
users' caches. So the data is already correct the moment it returns: both sent
lists are empty. `test_both_sent_lists_are_already_empty_after_a_cross_invite_accept`
pins that, and it is there to stop anyone "fixing" the push test by making
`accept()` delete more.

What was missing was the **notification**.
`friendship_request_accepted_callback` pushed `update_sent` to `from_user` and
to nothing else, so the inviter's Sent tab cleared and the accepter's did not.
The accepter's own HTTP response cannot cover it either: every one of the three
actions returns the *received* list on the resolve path, and
`SET_RECEIVED_INVITATIONS` is what it commits. So the row stays on screen with a
live Cancel button on it - and Cancel 404s, because `accept()` is the thing that
deleted it. `get_object_or_404` on all three endpoints, so the row cannot be
actioned at all.

The frontend is the second half of the same failure and it is reachable on its
own, without any cross-invite: the three handlers were bare dispatches and the
component had no `error` field and no element that could show one, so **every**
refusal - a 404, a 500, a dropped connection - re-rendered nothing, cleared no
badge and displayed no message. Pre-fix the jest spec did not merely fail: the
un-awaited rejection took down the Node runner outright, killing the whole
suite.

Fixed on both sides. The signal now pushes `update_sent` to both users, in a
`for` loop over `(from_user, to_user)` - the same reason, and the same shape, as
`friendship_request_rejected_callback`'s existing docstring. The component
routes all three handlers through one `actOnInvitation` that clears `error` up
front and reports a refusal, reusing item 19's wording rather than inventing a
third tone.

| Mutation | Fails |
|---|---|
| push only `from_user` (the old code) | the accepter test |
| push only `to_user` | the accepter test |
| drop the `this.error = ""` clear-up | the later-success test alone |
| empty the `.catch` body | the 3 refusal tests + the later-success one |
| `.catch` -> `.then` (report on success) | all 7 |
| `--fix` reflows the spec | nothing - lint is cosmetic |

The third row is the isolating one, and the two `signals.py` rows matter
together: dropping either user fails the same test, so it is pinning *both*
receivers rather than "some push happened". The last row is the honest negative -
lint reflowed the spec and nothing failed, which is expected and is why it is
listed rather than counted as verification.

Rebuilt; the artifact carries the message (`could not be updated` once in
`bundle.js`). **76 jest passed** (69 -> 76, 15 -> 16 spec files), **209 pytest
passed** (207 -> 209), lint clean, no migration drift. Invariants hold:
`onclose=function(){}` **0**, `console.log` **0**, `X-CSRFTOKEN` 1,
`retryDelay` 4, `?.` **0**.

**Honest limits.** The message is generic: a 404 here means *that invitation no
longer exists*, which is a refetch rather than a retry, and the copy does not
say so. The push fixes the common path, so this only bites when a push is
missed - socket down, mid-reconnect - and then the card still needs a manual
reload to clear itself. Branching on `error.response.status === 404` to
refetch would close that, and it is three more lines; it is not here because it
buys a rare case at the cost of a per-status branch the codebase currently only
has in `InvitationModal.vue`. Also note the `catch` swallows the error entirely,
which is the item 8 shape `UserProfile.vue` already accepted. And the second
test in the table above is the reason the defect was reachable at all rather
than merely possible: `unique_together` on the ordered pair is what makes a
mutual invite storable, so "two people invite each other" is not an exotic state
that needs defending against so much as one the schema invites.

### 30. The add-friend modal blamed a pending invitation for two refusals that
were not one (done)

This is the item that was filed as "the 400 wording collapse" and deferred
twice, both times for the same honest reason: fixing it means editing jest
suites that are currently green and asserting the wrong sentence. It is done
now, and the reason it was worth un-deferring is that the tests were wrong in a
specific, demonstrable way rather than merely strict.

`POST /friends/add/{id}` answers **three different refusals with the same
status**, and puts the reason in the body:

| cause | body |
|---|---|
| an invite already pending | `'Friendship request already exists.'` (string) |
| already friends | `'The users are already friends.'` (string) |
| your own address | `['Users cannot be friends with themselves']` (**list**) |

The modal answered all three with `status === 400 -> "You have already sent an
invitation."` So:

1. Add **someone who is already a friend** -> *"You have already sent an
   invitation."* You did not, and cannot have; they are a friend.
2. Type **your own email address** -> *"You have already sent an invitation."*
   You have never sent yourself anything.

Both are typed by the user into the one field on the one screen whose next
action is to press Send again. The third case is the only one where the
sentence was ever true.

Measured rather than read: `test_each_refusal_carries_its_own_reason` pins the
three bodies off the view, including that all three statuses are 400 - because
that is the trap, and it is why **the status cannot be branched on** to fix
this. Three causes, one code. The body is the only thing that distinguishes
them, so the fix reads the body.

Two shapes, not one: `ValidationError.messages` is a **list**, and the two
hand-built `Response({'detail': ...})` are bare strings. A fix that assumed the
string shape would render `[object Object]`-adjacent nonsense, or nothing at
all, for exactly the self-invite case. Both shapes are tested.

**The two specs that had to change.** Both built a 400 as
`{response: {status: 400}}` - **no body** - and asserted the modal's own
sentence. That is a response this server never sends: every 400 it returns
carries `detail`. So the fixtures were asserting against an unreachable
response. They now carry the body the view really sends, and assert the string
the view really produces. Item 24's suite
(`invitation_modal_stale_error.spec.js`) keeps its subject untouched - it is
about a second failure *replacing* the first rather than stacking, and it still
asserts two different messages, which is all that subject ever needed.

| Mutation | Fails |
|---|---|
| restore the collapsing 400 sentence | the 3 message tests, all 5 pre-existing pass |
| drop the `Array.isArray` flatten | the self-invite test alone |
| drop the generic fallback | the fallback test **and** item 18's network-error test |

The first row is the one that matters most: the original code fails **only** the
new tests and every pre-existing test still passes, which is the evidence that
nothing was weakened into agreeing. The third row shows the fallback is not
decorative - removing it re-breaks a test that has been green since item 18.

Rebuilt; the artifact no longer contains the old sentence (**0** occurrences,
`response.data` **2**). **79 jest passed** (76 -> 79), **210 pytest passed**
(209 -> 210), lint clean, no migration drift. Invariants hold:
`onclose=function(){}` **0**, `console.log` **0**, `X-CSRFTOKEN` 1,
`retryDelay` 4, `?.` **0**.

**Honest limits.** The modal now echoes a server-authored string into the DOM,
where before it only ever showed a client-authored one. The strings are this
project's own and it renders through `{{ error }}`, not `v-html`, so there is
no injection path - but it is a real change in kind and worth knowing about.
Nothing sanitises the text if a *future* validation error carries something
unflattering, and the `detail` key is not a contract this repo pins anywhere
else. The generic fallback covers a 500 and a proxy's HTML, not a 200 with a
surprising body. And the same collapse still exists in the lookup catch, which
deliberately keeps its own `404 -> "User not found."`: that one is a better
sentence than DRF's `{"detail": "Not found."}`, which is why it was not
generalised, and it is the only 404 body here that is worth overriding.

### 31. Verified, not defects

Recorded so the next sweep does not re-run them.

- **`PATCH /api/v1/me {"id": 9001}` does not rewrite the caller's primary key.**
  `UserSerializer` lists `id` in `fields` and marks only `username`/`email`
  read-only, so it looked writable. Measured against a live request: **200**, and
  the response and the database both still carry the original id - DRF forces
  the primary key read-only regardless of `read_only_fields`. A probe file was
  written, run and deleted rather than a test kept, because the answer is a
  negative and a permanent test of "this does not happen" is not worth its
  maintenance.
- **The two pagination branches sort differently, and it is unreachable.**
  `LastMessagesRoomAPIView` orders page one by `-timestamp` and every later page
  by `-id`. That diverges only if a message's timestamp can fall behind its
  neighbours' *and* the divergence drops a message from the walk. `timestamp` is
  `auto_now_add=True` (`chat/models.py:35`), set at insert, and nothing writes
  it directly - so id order and timestamp order cannot separate. This was filed
  PLAUSIBLE by an earlier sweep and is now settled rather than outstanding.
- **`Room.last_activity` is bumped only by real activity.** `auto_now=True`
  fires on every `Room.save()`, so an unrelated save would jump a chat to the
  top of the sidebar. There are exactly two `Room.save()` call sites in the
  codebase - message creation (`messageViews.py:164`) and room creation
  (`roomViews.py:309`) - and neither is reachable without a message or a room.
- **`SET_ROOMS` merges without reordering, and `fetchRooms` races
  `fetchRecentActivity`.** `UsersSection.vue:115` sorts by `last_activity`
  descending at render time, so insertion order is never observable. The race
  that looked like a bug is invisible by construction.

### 32. One malformed room request could brick an account (done)

`RoomViewSet.create` guards the private-chat case with

```python
if len(participants) == 1:
    raise ParseError(detail='There must be at least one another participant.')
```

The question that guard is asking - *does the author have anyone else in this
room?* - is a question about **distinct people**, and it was answered with a
**count**. So:

```
POST /api/v1/rooms/  {"kind": 1, "participants": [<me>, <me>]}
```

`me in participants` is true, so the author is not appended; the list is length
**2**, so the guard passes. Then `Room.get_or_create_private(me, me)` calls
`participants.add(me, me)`, which is **one** row - the M2M add is a set insert.
The room is a private room whose sole participant is its author, and it is
**committed before the serializer can object**: the 500 comes from rendering
the room that was just written.

A private room with one participant is not a thing the rest of the codebase
can read. Three readers index past the end of a one-element list:

| reader | index | reached by |
|---|---|---|
| `RoomSerializer.get_group_name` | `participants[0]` | the response to this very POST |
| `RoomSerializer.get_group_profile` | `participants[0]` | the same render |
| `RoomDeleteAPIView.post` | `participants[1]` | `POST /rooms/<id>/delete` |

Measured, not inferred - the probe walked the state the request leaves behind:

```
POST raised: IndexError list index out of range
rooms persisted: 1
  room 1 kind 1 participants [1]
GET /rooms/       -> RAISED IndexError list index out of range
GET /rooms/recents -> RAISED IndexError list index out of range
POST /rooms/1/delete -> RAISED IndexError list index out of range
```

**That is the whole defect in one list.** The first two are `fetchRooms` and
`fetchRecentActivity`, the app's two requests on load - so the account cannot
render its chat. The third is the endpoint that would have cleaned it up, and
it fails the same way, so **there is no recovery through the API**. One
malformed request, and the only row that could have been deleted to undo it is
itself undeletable. Nothing the client does fixes this; it is permanent until
someone reaches into the database.

The fix is one condition, at the write boundary, so the row is never written:

```python
if len(set(participants)) == 1:
```

`set` compares by primary key, which is the same equality `me in participants`
and `participants.remove(...)` already use - so this changes only the count,
not who is in the list.

**One test, not two.** The private case is the one that 500s, but it is *not*
the one that pins the guard: deduping the list instead of rejecting gives
`[me]`, which the pre-existing `len(participants) != 2` check then rejects with
the same 400 and no row. So the private test passes under a fix this test was
written to reject, and pinning needs the branch that has no such backstop:

| Mutation | Fails |
|---|---|
| revert to the length count | **both** new tests, other 40 pass |
| dedupe the list instead of rejecting | the **group** test alone |

The second row is the point. A group has no "exactly 2" check, so a weakened
guard creates a group room the author is the sole member of - no 500, just a
chat nobody can ever join, which is why `test_group_naming_the_author_twice_is
_rejected` exists rather than the private test being trusted to cover the
shared guard.

**212 pytest passed** (210 -> 212), **79 jest passed** (unchanged - no frontend
touched, so the committed bundle was not rebuilt), lint clean.

**Honest limits.** This closes the only client-reachable route, because the
frontend never POSTs to `/api/v1/rooms/` at all - rooms come into existence
through the friendship-accept signal, whose two arguments are provably
distinct (`add_friend` rejects a self-invite). `Room` *is* registered in
`chat/admin.py`, and the default ModelAdmin form lets a staff user build the
same one-participant room, so the wedge is still reachable from the admin. The
read paths were left indexing on purpose: softening `participants[0]` into a
safe lookup would turn a loud 500 on corrupt data into a silently blank chat,
which is the worse failure for a data-integrity problem. If a bad row ever
exists, it is one SQL `DELETE` - and it can only have come from this request.

### 33. A second sweep, and what it did not find

The area left after item 32 was the friends manager, the two API view modules
the sweep had not opened, and the untested components. Read in full, it
produced **no new defect**. Recorded so the next pass does not re-run it, and
so the negatives are as checkable as the positives.

- **`get_pending_messages` deletes join rows while iterating the queryset that
  selected them** - the shape that skips records. Measured rather than argued:
  150 pending messages against `GET_ITERATOR_CHUNK_SIZE` of 100, one
  `GET /api/v1/messages/`, and **0 left pending, 150 returned**. No skip on this
  backend. Not a defect here, and worth not "fixing" blind - it would be a
  `list()` in the right place, but there is no observable failure to justify it.
- **Four dispatches reject into nowhere**: `postWriting` (`SendForm.vue:114`),
  `markMessageAsRead` (`SentMessage.vue:79`, `ReceivedMessage.vue:71`) and
  `markRoomAsRead` (`MessagesSection.vue:239`). `throttleFunction` discards the
  promise and there is no `.catch`, no axios interceptor and no
  `Vue.config.errorHandler` - so a failed POST is an unhandled rejection.
  **Deliberately not treated as a defect**, despite `App.vue:30` stating the
  opposite rule: none of the four has a user-visible failure. A refused
  `markRoomAsRead` commits nothing, so the unread badge correctly stays up; the
  other three are a typing ping and two read receipts. Console noise only.
  Filing it would be manufacturing an item, and the fix is real code churn for
  no user outcome.
- **`add_block` sends `block_created` twice** (`friends/models.py:606-607`),
  where `add_follower` sends three *distinct* signals. Already recorded by
  `friends/_tests/test_follow_block.py:133`, which pins the duplicate. Correct
  not to touch it: `friends/signals.py` has no `blocked_created` to send
  instead, and nothing in the project connects a receiver to any block signal -
  the whole Follow/Block pair is vendored code with no caller.
- **`RoomSerializer.get_last_message` marks the last message delivered, from a
  GET** - the side effect the export endpoint was fixed for. Not the same
  defect: a download is read-only by definition, whereas listing your chats is
  the app's main view and marking delivery there is coherent with this app's
  model. Left alone deliberately.
- **`FriendshipRejectAPIView` has no `rejected__isnull=True` filter** that
  `FriendshipAcceptAPIView` does, so a second reject is accepted. No observable
  harm: `reject()` overwrites the same row, so the rejected list is unchanged
  and the only cost is a redundant push. Asymmetric defensiveness, not a bug.
- **`Example.vue` is unreferenced scaffolding.** Confirmed it does not ship:
  **0** occurrences of "Example modal" in `static/dist/bundle.js`, and no
  import from `main.js` or `App.vue`. Webpack drops it, so it costs a source
  file and nothing at runtime.
- **`IndexTemplateView`'s `DEBUG` branch.** The one branch no test can reach -
  Django's test runner forces `DEBUG=False` - is not dangling: both
  `index.html` and `index-dev.html` exist, and `test_entry_point.py:89` already
  renders the dev one.
- **Two things that look wrong and are not.** `User.vue` emits `whosWriting` as
  an object `{value, room}` while `Rooms.vue` renders it through a String prop -
  `Home.vue:setWriting` destructures it and only sets it when the room is the
  selected one, so there is no `[object Object]`. And `User.vue`'s unread badge
  compares `Object.values(state.unreadMessages)` against a bare room id -
  correct, because `ADD_UNREAD_MESSAGES` stores `{message_id: room_id}`, so the
  values *are* room ids and the count is one per unread message.

Also settled while reading: `FriendshipCancelAPIView` scoping to
`friendship_requests_sent` (including rejected rows) is correct - cancelling a
dismissal should delete it, and `rejected_requests` reads the *receiver's* rows.

### 34. A third sweep, and one trap worth naming

The last unread surface: `MessagesSection.vue` in full, the store's merge logic,
the axios/CSRF layer, `djchat/urls.py`, the profile serializer, and the message
paging view. Again **no new defect**. Most of it is routine, but one entry is a
trap, and it is recorded for that reason rather than for what it found.

- **`response.data.room` from `GET /api/v1/messages/<id>` looks like a dead
  field, and removing it would break paging.** `fetchPastMessages` reads only
  `.messages` and `.users`, which makes the view's `room_serializer.data` look
  like dead computation on a read endpoint - extra query, peer `UserSerializer`,
  and a `remove_user_from_pending` write, all shipped and all discarded. It is
  not discarded. `MessagesSection.vue:188` reads it:

  ```js
  if (response.data.room.id !== this.$store.state.selectedRoom) return;
  ```

  That is item 12's guard - the room this page was fetched *for*, so a late
  "nothing older" from the chat you just left cannot cap the one you opened.
  The action layer ignoring the field is not the same as the component layer
  ignoring it. This was nearly filed as dead weight, which is exactly what
  "verified, not defects" is for: the check that stopped it was reading the
  one component that had not been read yet.
- **The `remove_user_from_pending` write that `room_serializer` triggers on the
  paging endpoint is benign.** Scrolling to old messages marks the room's
  *newest* message received, which looked wrong. It is not: the caller is in
  the room, so their client does have that message, and `pending_reception` is
  about what the client holds. `all_received` still needs both sides.
- **`SET_RECEIVED_INVITATIONS` has no null guard** that its `SET_SENT_INVITATIONS`
  sibling has (`mutations.js:151`), so `undefined.forEach` would throw. Not
  reachable: `FriendshipRequestListAPIView` returns `Response(serializer.data)`,
  and DRF renders an empty `many=True` serializer as `[]`, never `null`.
- **`syncDB` is dispatched without being awaited** in all three of `fetchRooms`,
  `fetchRecentActivity` and `fetchMessages`. Harmless: it is three synchronous
  commits and cannot reject.
- **`CSRF_TOKEN` is captured once at module load** (`backend/csrf_token.js:21`),
  so Django's login-time `rotate_token` would leave it stale. Not reachable
  here: every login and logout in this app is a full page navigation
  (`Menu.vue` links to `/accounts/logout/`, registration is Django's own view),
  so the bundle is re-evaluated and the cookie re-read.
- **The `DEBUG`/`SECRET_KEY`/`ALLOWED_HOSTS` defaults in `settings.py` are a
  real deployment hazard** - and already recorded, in `problems.txt:6-10` and
  item 15. Not re-filed. They are a deployment-configuration decision, and the
  env vars that fix them are the user's to set.
- **The edit to `chat/migrations/0002`** is prior work and is sound:
  `datetime.datetime.now` -> `timezone.now` on a migration that is already
  applied and long since superseded by `0001`... `0011`. No drift; `makemigrations
  --check` is clean.

### 35. A fourth pass by measurement instead of by reading

The first three sweeps all worked the same way: read a surface, reason about it,
write down what is wrong with it. That method has a ceiling, and after three
passes returning nothing the honest question was whether the emptiness was a fact
about the codebase or a fact about the method. Reading everything twice does not
tell you which lines are load-bearing. So this pass measured instead:

```
coverage run --source=djchat -m pytest
TOTAL  2516 stmts   51 miss   98%
```

`pytest-cov` is not installed, so this is standalone `coverage` (7.16.2) driving
pytest directly. Fifty-one uncovered statements across the entire project is
small enough to decode by hand, which is the only reason this pass was worth
running. They are not scattered. They fall into seven groups, and every one is
inert:

| Where | Lines | What |
|---|---|---|
| `__str__` methods | `chat/models.py:57`, `friends/models.py:113,451,556,666` | repr methods no code path calls |
| `save()` self-guards | `friends/models.py:561,671` (+ `Friend.save`) | defense in depth behind the manager-level `ValidationError` |
| `remove_friend` | `friends/models.py:414-415` | genuinely unreachable: `if qs:` guards the only `qs[0]`, and `delete()` on an empty queryset returns 0 without raising |
| the `elif` cache branch | `friends/models.py:424,532,638` | one per predicate - see below |
| `friends/api/views.py` | `65,86,100` | the `get()` delegations on Accept/Reject/Cancel |
| test scaffolding | `friends/api/test.py:18-20,26,29,52,59,62,65,68` | an unused `login` context manager and four unused `assertResponse*` helpers |
| entry points | `manage.py`, `wsgi.py`, `routing.py` | never imported under test, as expected |

**The `elif` branch is the interesting one, and the finding is a negative worth
naming.** All three cache predicates read *two* caches before falling through to
the database:

```python
friends1 = cache.get(cache_key("friends", user1.pk))
friends2 = cache.get(cache_key("friends", user2.pk))
if friends1 and user2 in friends1:   return True      # covered
elif friends2 and user1 in friends2: return True      # 424, never hit
else: ...Friend.objects.get(...)                      # covered
```

`are_friends:424`, `follows:532` and `is_blocked:638` are all correct - the
reverse cache answers the same question as the forward one, because both models
store the relation in both directions. But they are **pure optimisations**. The
`else` branch is authoritative and returns the same answer, so deleting all
three would change nothing observable and no test could fail. That is precisely
why no test covers them: there is no behaviour there to pin. They are left
alone. The tempting move - three tests to "cover" the gap - would buy nothing
and assert only that the code still says what it already says.

**The `get()` delegations are not a coverage gap in any meaningful sense.** All
three are routed, so DRF will dispatch a browser GET to them, but each is a
single delegating statement with no logic of its own, the frontend only ever
POSTs to all three (`actions.js:179,201,212`), and the view they delegate to is
already pinned for both 200 and 404. Testing them would assert that a
one-line delegation still delegates.

**One near-miss, and it is the reason this pass was worth running.** Those three
uncovered `get()` methods hand the request to
`FriendshipRequestDetailAPIView.get`, and the acceptance-test instinct is to
call that an IDOR: an unowned-detail endpoint reachable by guessing a small
sequential id. The detail view does scope it -
`FriendshipRequest.objects.filter(Q(from_user=request.user) | Q(to_user=request.user))`
(`views.py:145-146`) - so a non-party gets 404, and the detail GET is already
pinned at `test_friendship_api.py:434`. Filed without reading line 145, this
would have been a wrong item in the log that the next session had to re-open.

**Skipped tests.** Run separately, because a skip hides a failure silently:
`pytest -rs` reports **zero skipped** and zero xfailed, so nothing is quietly
unprobed by environment. `manage.py check` is clean. No migration drift.

Nothing changed. The value of this pass is the measurement: 98% with the
remainder decoded, and the near-miss recorded as a near-miss. Four passes, one
real defect (item 32). I am treating that as the signal to stop hunting and put
the three open decisions to you instead.

### 36. The deploy now builds (decided, done)

Three decisions were put to you; you answered one - **add the frontend build to
the deploy**. The other two (the dead `viewed` axis, the `Message.body` 500-char
cap) are left untouched and still open.

**The deploy was not in the repo.** That is the first fact worth having. There
is no `.github`, no Dockerfile, no Procfile, no Makefile, and no `.sh` file
anywhere outside `venv/` and `node_modules/`. What exists is a *prose* start
command at `problems.txt:4`, and the git history shows the ritual it describes:
every commit titled `deploy`, `deloy again` or `update dist` pairs a
`frontend/src/*.vue` edit with a `static/dist/bundle.js` edit. The build was a
manual step somebody remembered, which is precisely the thing that fails
silently.

So the change adds the one artifact that was missing - **`deploy.sh`**, which
runs `npm ci && npm run build` into `djchat/static/dist` and then the start
command from `problems.txt:4`, unchanged. It refuses to run without the three
`DJANGO_SUPERUSER_*` variables rather than shipping placeholders.

**The honest limit, which `problems.txt` had already spotted and which the
choice deliberately accepts: this needs Node on the machine that runs it.** The
app itself needs no Node at runtime, and the previous note said plainly that
adding npm to the start command "would break a host that does not have it." If
the deploy host has no Node, do not install this script as the host's start
command - build on your own machine and commit `static/dist`, which is what every
existing commit already does. Both paths are documented in `problems.txt` now.

One behaviour carried over on purpose rather than fixed: `createsuperuser
--noinput` exits non-zero when the superuser already exists, and under both the
old `&&` chain and this script's `set -e` that stops the sequence **before
daphne**. That may bite on a redeploy, but I do not know what your host does with
the exit code, and silently changing deploy semantics to fix a problem I cannot
reproduce would be worse than leaving it visible. It is called out in a comment
on the line.

Three files followed from this:
- `djchat/core/_tests/test_deploy_script.py` (new) pins the two facts that are
  load-bearing and invisible elsewhere: the build precedes the serve line, and
  the serve line is `daphne -e ssl:443 -b 0.0.0.0 djchat.asgi:application`.
  The TLS half is not decoration - `test_tutorial_route.py` rests on it,
  because the frontend hardcodes `ws://` and only reaches the socket when
  something terminates TLS. Stripping comments before matching matters: the
  header mentions daphne while explaining the app does *not* need Node, and
  matching the bare word would order the build against a sentence.
- `test_entry_point.py:158` claimed "problems.txt already records that the deploy
  never rebuilds it." That became false the moment the script landed, and a
  reader would have concluded a deleted frontend file could never be removed
  from the served directory. One clause corrected; no assertion touched.
- `problems.txt:13-23` rewritten to point at `./deploy.sh`, keeping the
  no-Node-on-the-host warning rather than dropping it now that it is actionable.

Reversions, all three failing the *named* test: R1 removes `npm ci` ->
`test_the_deploy_builds_the_bundle_before_it_serves`; R2 removes `-e ssl:443` ->
`test_the_deploy_serves_the_asgi_app_over_tls`; R3b moves `npm run build` after
the serve line -> the ordering test, with the TLS test staying green. An earlier
R3 placed the build before `echo "==> serving"` rather than after `exec daphne`,
passed, and was worthless - the anchors had matched, so it was not a silent
no-op, it was simply not the mutation I meant to write. Re-run correctly, it
fails.

### 37. The invitation actions are now covered by construction (done)

The `Verification gap` section above named one real hole and left it open: the
`test.each` in `invitations_refusal.spec.js` enumerates three actions in a
hand-written table, so a **fourth** action added to `Invitations.vue` would be
covered by nothing and a typo in its dispatch name would surface only as an
invitation that never updates. Adding an action is ordinary work; the suite
would have stayed green throughout it.

The fix is one test and no production change. `Invitations.vue` wires its three
handlers straight into the template:

```
<user-invitation ... @add="acceptInvitation" />
<user-invitation ... @remove="rejectInvitation" />
<user-invitation ... @remove="cancelInvitation" />
```

so the spec reads that file, collects the handlers wired to the row component,
and asserts the table covers exactly them. A fourth action now fails
`every handler the template wires to a row is in the table` at the moment it is
written, and adding it to the table is all it takes - the two `test.each` blocks
then pick it up for free. The gap was never "no coverage"; it was "no signal
that coverage had a hole in it", and that is the part this closes.

**The first version of that test did not close it, and the reversion is the
interesting part.** I scanned for `@add` and `@remove` - the two events the
component uses today - and simulated a fourth action on a new event name
(`@ignore="ignoreInvitation"`). It **passed**. That is precisely the shape of
the gap: a new action brings a *new* event name, so a scan restricted to the
existing two walks straight over it. The test would have read as closing the gap
while leaving it wide open. Fixed by scoping to `<user-invitation>` tags and
matching **any** event on them, keeping the leading `@` (so `:prop` bindings
stay out) and requiring a bare identifier (so expression handlers are dropped).

Reversions, each failing the named test:
- **R1** a fourth action on a new event name (`@ignore`) -> the contract test.
  This is the stated gap, reproduced exactly.
- **R2** `@add` wiring deleted -> the contract test.
- **R3** a fourth action reusing an *existing* event name (`@remove` twice) ->
  **not a test failure.** The template compiler rejects the duplicate attribute
  and the suite fails to load, `0 total`. Still loud, but that is the compiler
  doing the job rather than this test, so it is not counted as a reversion and
  R3 above refers to the `@add` deletion. Reusing an event name is not a real
  way to add an action anyway - the child would have to emit two handlers for
  one event.

The spec is the only file changed; `Invitations.vue` is byte-identical after the
reversions, checked against the pre-reversion copy and by reading the three
bindings back. jest 79 -> **80**, pytest unchanged at **214**.

### 38. The invitation row had no keyboard path (done, and the rest is scoped)

Item 37 pinned the parent's side of the invitation contract. Following it to the
other end - the row that emits `add`/`remove` - turned up something bigger than
that task, and it is worth writing down as a class rather than a fix.

**There is no keyboard path to this app's primary interactions.** Measured
across every component with a `@click`, four interactive surfaces are built on
elements that are not focusable, carry no role, and have no accessible name:

| Where | Surface | Element it actually is |
|---|---|---|
| `UserInvitation.vue:39,49` | accept, reject/cancel a request | `<i>` with the icon ligature as its only text |
| `UsersSection.vue:29` | **every chat row in the app** | `<div>` per room |
| `UsersSection.vue:6` | own avatar -> own profile | `<div>` |
| `MessagesSection.vue:105` | "go to bottom" | `<p>` |

A keyboard user cannot accept a friendship request, cannot open a chat, and
cannot reach their own profile. A screen reader is offered `person_add`,
`delete`, an avatar initial, and - for the room rows - nothing at all, because
`selectRoom` is bound to a `<div>` whose content is a child component.

**Fixed here: the invitation row's two controls**, because that is the surface
item 37 had just pinned and the worst case in the table - icon-only, with *no*
text to announce at all. Both are now `<button type="button">` wrapping the
unchanged `<i>` glyph, so the visual is identical; the button carries an
`aria-label` ("Accept invitation", and a `Reject`/`Cancel` one that follows
`received`), and the glyph is `aria-hidden="true"` because the ligature is text
content and a screen reader would otherwise read the font's internal name. The
component's contract is untouched - same props, same `add`/`remove` emissions,
same `invitation.id` payload - so `Invitations.vue` needed no change and item
37's template test is unaffected.

**Deliberately not fixed, and it wanted its own task:** the room list
is the single most-used interactive surface here and every row is a `<div>`. That
is a real change to how the list behaves and reads, it wanted more than a bolt-on,
and doing the invitation row alone did not pretend the rest was done. Item 39 is
that task.

**One near-miss worth naming.** `keeps the icon ligature out of the accessible
name` **passed against the broken component**: zero buttons, a `forEach` over
nothing, green. Exactly the failure mode item 30 recorded - a green test pinning
nothing is worse than no test. It now asserts the count first, and R2 below is
what proves it bites.

Reversions, each failing the *named* test and no other:
- **R1** both controls back to `<div>` -> all five fail. This is the regression
  the fix exists to prevent.
- **R2** `aria-hidden` dropped from both glyphs -> only the ligature test.
- **R3** the accept control's `aria-label` dropped -> only the focusable test.

`tabIndex` is what makes R1 more than a tag check: a native `<button>` is `0`,
an `<i>` or `<div>` is `-1`, so the assertion fails on the actual reachability
rather than on the element name.

Bundle rebuilt (`npm run build`) and verified to carry the change -
`Accept invitation`, `Reject invitation`, `Cancel request` and two `aria-hidden`
are all present in the committed `static/dist/bundle.js`. Without that step this
fix would have been a no-op in production, which is the trap item 36 removed.

Also noted and left alone: `UserInvitation.vue` imports `dateformat` and defines
a `formatDate` method that no template uses, and carries a commented-out `<img>`
avatar block. Dead, but not this item's business.

jest 80 -> **85** (17 suites), pytest unchanged at **214**.

### 39. The room list had no keyboard path either (done)

The scope-out item 38 named, plus the two smaller surfaces in the same class.
Three fixes, and they are not the same fix.

**The room row** (`UsersSection.vue:29-41`) was

```html
<div v-for="room in rooms" :key="room.id" @click="selectRoom(room.id)"
     class="user-row" v-show="checkIfRowInQueriedResults(room.id)">
```

and is now the same element with four things added: `role="button"`, `tabindex="0"`,
`:aria-current="room.id === $store.state.selectedRoom"`, and
`@keydown.enter.space.prevent="selectRoom(room.id)"`.

**Not a `<button>`, and that is deliberate.** `<user>` renders a
`<div class="user-row ...">` holding `<p>`s, and a `<button>`'s content model is
phrasing content - turning the subtree into spans to fit is a far larger change
than the defect warrants. `role="button"` + `tabindex="0"` + Enter/Space is what
the ARIA authoring practices prescribe for an element that cannot become a native
button, and it costs **no stylesheet change at all**: the padding, the border and
the hover tint all live in `User.vue` and were not touched.

**No `aria-label` on the row, on purpose.** The name comes from content -
`{{ room.group_name }}` is inside the row - so a screen reader announces *which*
chat the control opens and the last message and timestamp along with it. An
`aria-label` here would name the button "Bob" and hide everything inside it.

`aria-current` because the selected room was otherwise conveyed only by
`bg-gray-200`, inside `User.vue`, and no further. Vue drops the attribute when the
binding is false, so the open chat is the one row that carries it.

**The avatar** (`UsersSection.vue:6-14`) was `<div @click="$emit('profile')">` whose
entire text content is the user's initial - a one-letter accessible name. Now a
`<button type="button" aria-label="Open your profile">` (`Home.vue:34` routes the
event to `toggleLeftSidenav`). Checked the stylesheet before changing the tag:
Tailwind 1.x already sets `button,input,select,textarea{font-family:inherit}`, so
the letter does not change face, and it resets neither `border` nor `background`,
so `p-0 bg-transparent border-0` is the same three classes item 38 needed. The
contents are a single text node, so the native button is spec-valid here.

**"(go to bottom)"** (`MessagesSection.vue:104-110`) was a `<p @click>`; now a
`<button type="button">` with the same three classes. No keydown handler here -
a native button already has Enter and Space, and that is the difference between
this surface and the room row.

**Five isolating reversions**, each failing the intended test and nothing else:

| reversion | result |
| --- | --- |
| **R1** room row loses `tabindex="0"` | only `is reachable by Tab` |
| **R2** room row loses the keydown handler | only the Enter and Space tests |
| **R3** room row loses `aria-current` | only `marks the open room` |
| **R4** avatar back to a `<div>` | only `is a named control` |
| **R5** go-to-bottom back to a `<p>` | both go-to-bottom tests |

R1 and R2 are the pair worth having: reachability and operability fail
independently, so neither test is passing for the other's reason. R4 leaving
`still opens the profile` green is the control that the avatar's click already
worked and nothing here was invented.

**One assertion I got wrong, and the app was right.** `still scrolls to the
bottom` first asserted that clicking clears the banner. It does not, and it should
not: `scrollToBottom()` scrolls and does nothing else - line 148 sets
`fixScrollToBottom`, and `newMessagesReceived` is cleared by `onScroll` when the
list reaches its end. In a browser `scrollTo` fires that event; jsdom has no
layout, so it never arrives. Asserting it would have been asserting a mechanism
this code does not have. It now pins what the handler actually does, with a
non-zero `scrollHeight` defined on the ref first, because jsdom reports every
scroll dimension as 0 and a bare `toHaveBeenCalled` would have passed on a
handler that scrolled to the *top* of the list.

Bundle rebuilt and verified to carry the change: `role:"button"`, `tabindex`,
`aria-current`, `keydown`, `Open your profile` and `go to bottom` are all present
in the committed `static/dist/bundle.js`.

**Left alone, and named so it is not lost.** `User.vue`'s inner div carries
`cursor-pointer hover:bg-gray-100` although the click handler lives on the parent.
That is decoration on a non-interactive element - and also the only thing making
the row *look* clickable, so removing it would be a visual change for no gain.

**The list is not `listbox`/`option`.** `role="button"` per row is the smaller
correct change. Arrow keys still do not move between rows and the row count is not
announced; those want roving tabindex, which means deciding whether this list is
navigation or selection. Not taken on unasked.

**Adjacent, and not fixed.** Five elements carry `focus:outline-none` with no
replacement: `Invitations.vue:10` and `:30` (the Sent/Received tabs),
`SendForm.vue:6` (the message box), `UserProfile.vue:61` (the profile
description) and `InviteButton.vue:7` ("Invite a Friend"). `Search.vue:5` and
`InvitationModal.vue:15` pair it with `focus:shadow-outline`, which this Tailwind
build has. Those five are *already* focusable, so this is a separate defect from
everything above - focus that lands somewhere you cannot see - and fixing it is a
visible style change to elements this item never otherwise touches. **Item 40 is
that fix.** (It is five, not four: item 39's own first pass missed
`InviteButton.vue` because a line-based grep cannot see that its class attribute
wraps onto the next line.)

jest 85 -> **95** (17 -> 18 suites), pytest unchanged at **214**.

### 40. Five focusable elements made focus invisible (done)

Not reachability this time - every one of these five is already a real `<button>`
or `<input>` and already takes focus. The defect is that **focus lands somewhere
you cannot see**.

Tailwind's preflight gives every button and input a focus ring. `focus:outline-none`
takes it away. On two elements something puts it back; on five, nothing does:

| site | what it is |
| --- | --- |
| `SendForm.vue:6` | the message box |
| `UserProfile.vue:61` | "Add some info." |
| `InviteButton.vue:7` | "Invite a Friend" |
| `Invitations.vue:10` | the Sent tab |
| `Invitations.vue:30` | the Received tab |

`Search.vue:5` and `InvitationModal.vue:15` remove the outline *and* replace it
with `focus:shadow-outline`. So the convention already exists in this codebase -
this is the existing pattern, not a new one. All five now carry it.

**The near-miss, and it was mine.** Item 39 recorded this as "four elements" from
a line-based `grep`. It is five. `InviteButton.vue:7` wraps its class attribute
onto line 8 (`active:shadow-none mr-2"`), and a grep that counts matching *lines*
sees one line either way - so the site looked identical to the four that were
correct. The spec below uses `/class="([^"]*)"/g`, which spans newlines, and R3
exists specifically to prove it.

**The test scans `src/**/*.vue`, not these five files.** Naming them here records
what was found; the scan is what stops a sixth. And it matches individual
`class="..."` attributes rather than files, because a file-level check would be
worthless here: `Invitations.vue` has two offenders, so a file that gains the
class on one tab would look fixed. R2 is what proves the difference.

**Three reversions**, each failing the scan test and leaving the artifact test
green:

| reversion | result |
| --- | --- |
| **R1** all five sites reverted | scan test fails, naming all five files |
| **R2** one of `Invitations.vue`'s two tabs reverted | scan test fails, naming only `Invitations.vue` |
| **R3** only the wrapped class attribute reverted | scan test fails, naming only `InviteButton.vue` |

The second test asserts the indicator class is really in `static/dist/bundle.css`
- that this build emits `.focus\:shadow-outline:focus` *with* a `box-shadow` in
it. Without it all five fixes could be a class the build never produced, which is
the artifact half of the trap item 38 found.

**Restoring the file, andnot cleanly.** A reversion script I wrote badly emptied
`Invitations.vue` to a 60-byte fragment mid-verification. `git checkout` would
have been wrong - HEAD predates item 37, so it has no `error` field and checking
it out would have silently reverted that too. The file was rebuilt from this
session's opening read of it, and the diff against HEAD is now exactly item 37's
error handling plus item 40's two class attributes. `invitations_refusal.spec.js`
mounts the component and exercises its methods and its template wiring, so it
fails loudly on a bad restore rather than passing quietly - that is what it is
for.

Bundle rebuilt. `focus:shadow-outline` goes 2 -> **7** in the committed
`bundle.js`, and `focus:outline-none` is now also exactly 7 - the two counts
matching *is* the invariant, confirmed in the artifact rather than only in source.

jest 95 -> **97** (18 -> 19 suites), pytest unchanged at **214**.

### 41. The last delivery tick was never pinned to anything (done, and it is tests only)

Item 35 measured *statement* coverage and found nothing left. **Branch**
coverage is a different measurement and it found something immediately - 19
partial branches, code paths where one direction is never taken. Two of them:

```
djchat/chat/models.py ... 72->exit, 79->exit
```

Those are the guards that make the delivery tick wait for the last person:

```python
def remove_user_from_pending(self, user):
    if self.pending_reception.filter(id=user.id).exists():
        self.pending_reception.remove(user)
        # If there are no more pending then signal
        if not self.pending_reception.exists():        # <- 72
            self.signal_to_room('update_message', {..., 'kind': 'all_received'})
```

**The proof this was a real gap, not a branch-coverage curiosity: delete both
guards and every test in the project still passes.**

```
guards removed -> 214 passed     failed tests: NONE
```

With the guard gone the push fires on the *first* participant to open a chat
instead of the last, so `User.vue` shows the double tick - everyone has received
this - while two people have not received it. Nothing noticed.

**It was on the list already.** `chat/_tests/message_test.py` is 68 lines of
Spanish `#` comments and no code, and its final block says:

```
# All received and all read

# Check that all receive is true when all users have received it
# and false when one or more user have not.
```

The author knew this contract was unwritten. It now is:
`chat/_tests/test_message_pending.py`, and the TODO block is struck through with
a pointer to it - a stale TODO is the same rot items 36 and 37 corrected.

**A near-miss worth naming, and it nearly went into PLAN.md as a fact.** A grep
for `remove_user_from_pending|mark_as_read|pending_reception|all_received` over
`chat/_tests/` returned *nothing*, and I read that as "zero coverage, everywhere".
It was wrong: the grep ran with `2>/dev/null` from a working directory where that
relative path did not exist, so it found no files and reported no error.
`test_consumer.py:216` and `:227` are named
`test_acking_the_last_receiver_pushes_all_received` and
`test_reading_the_last_reader_pushes_all_read`. A suppressed error is not a
negative result.

**Those two cover the firing half, and only that.** Both build a message with a
*single* pending user (`pending_reception=[other]`), so the guard is always about
to be true. That is why deleting it left them green - they cannot distinguish
"the last one is gone" from "someone is gone".

**Four reversions**, each run against the new file *and* `test_consumer.py` so
the contrast is visible:

| reversion | result |
| --- | --- |
| **R1** drop the `all_received` guard (`:72`) | both new reception tests fail; **both consumer tests stay green** |
| **R2** drop the `all_read` guard (`:82`) | both new read tests fail; **both consumer tests stay green** |
| **R3** drop `is-this-user-pending` (`:69`) | only `asking_twice` fails |
| **R4** drop `is-this-user-pending` (`:79`) | only `asking_twice` fails |

R1 and R2 are **not** mutually isolated - each fails both new tests, because the
second one also asserts a first pass that announces exactly once, and a missing
"nothing left" guard announces on every removal. Measured and reported rather
than dressed up. R3/R4 are one test each. And the bolded half of R1/R2 is the
result that matters: the pre-existing consumer tests do not notice their own
guard being deleted, which is the defect.

**A layer spy, not a socket.** `receive_output` *raises* `asyncio.TimeoutError`
on timeout **and cancels the communicator's application task** (asgiref
`ApplicationCommunicator.receive_output`), so expressing "nothing was pushed"
that way would cost the socket for the rest of the test. Patching
`chat.models.async_to_sync` records the send itself, and since
`signal_to_room` addresses every participant, it also proves the push goes to all
three groups rather than to whoever cleared their set.

**Room kind comes from `Room.RoomKind.GROUP`,** not a literal, so the test cannot
drift from the enum - the same reasoning as `send_form_maxlength.spec.js`.

### 41a. The other 17 partial branches are inert, and one is provably so

`roomViews.py:314->321` is the `elif (kind == 2)` falling through to
`serializer.save()` with no validation - reachable, on its face, by any `kind`
that is neither 1 nor 2. It is not reachable. `Room.kind` is
`IntegerField(choices=RoomKind.choices)`, so DRF builds a `ChoiceField`:

```
field class : ChoiceField
choices     : {1: 'Private', 2: 'Group'}
kind errors : {'kind': ['"7" is not a valid choice.']}
```

`validated_data['kind']` can only ever be 1 or 2, and the `if` at :301 always
returns. **No test could meaningfully pin it** - same verdict item 35 reached for
`friends/models.py`. The other partials there are the `if qs:` cache guards,
whose `else` branch is a pure optimisation over a DB query that is authoritative.

pytest 214 -> **218**. `chat/models.py` partial branches 2 -> **0** (96% -> 99%),
project-wide 19 -> **17**. jest unchanged at **97**.

### 42. The socket endpoint was written down twice and nothing tied the copies together

Coverage said `djchat/djchat/routing.py` was at **0%** - never imported by anything.
Chasing it turned up the real thing, which no number points at.

The endpoint exists in two languages and both halves were pinned - just never to
each other:

| half | lives in | pinned by |
|---|---|---|
| client | `App.vue:23`, `scheme + window.location.host + "/ws/notifications/"` | `websocket_reconnect.spec.js:91,97` |
| server | `chat/routing.py:7`, `re_path(r'ws/notifications/$', ...)` | `test_consumer.py:21`, `WS_URL` |

**Proven escape, before writing anything.** Rename the server half and its own
test literal together, which is exactly what a person renaming an endpoint does:

```
chat/routing.py -> ws/chat/,  test_consumer.py WS_URL -> /ws/chat/,
App.vue untouched

pytest  218 passed
jest     97 passed
```

The browser now 404s its socket into `onclose`, and `reconnectWebSocket` retries
at 1s..30s for the rest of the session saying nothing - items 2, 16 and 17 doing
their job, which is exactly what makes the failure invisible. The mirror works
too: rename `App.vue` and the two jest literals, and `test_consumer.py` never
notices.

`chat/_tests/test_socket_path.py` is the one test that puts the two halves in
front of each other. It asks the real question a browser asks - *can I get in at
this address* - against the real `djchat.asgi.application`, signed in with a real
session cookie:

- **Not a regex match.** `AsyncConsumerRouter` resolves inside `__call__` and
  exposes no `resolve()` to call (I wrote that version first and it failed with
  `AttributeError`). A hand-rolled matcher for `ws/notifications/$` would be a
  fourth copy of the pattern, and a copy is what this file exists to delete.
- **Not the consumer directly.** `consumer_for()` in `test_consumer.py` hands
  the communicator `ChatConsumer.as_asgi()`, so `WS_URL` is a decoration there and
  the routing table is never consulted.
- `test_consumer.py`'s one use of the full application asserts a *refusal* -
  and an unroutable path also produces no accept, so it cannot tell the two apart.
  That is the specific hole.

Three reversions, each failing that test alone and nothing else in the project:

| | change | failed |
|---|---|---|
| **R1** | server route renamed, `WS_URL` updated | `test_socket_path.py` only |
| **R2** | `App.vue` renamed, both jest literals updated | `test_socket_path.py` only |
| **R3** | `App.vue` no longer derives the path from `window.location.host` | `test_socket_path.py` only |

R3 exists because the extraction is a regex over `App.vue`, and a regex that
matches nothing is a test that passes. It asserts it found something first, and
fails with "an endpoint nothing can read the client side of cannot be checked
against the router" rather than reporting a green run.

R1 also caught a weakness in the test's own failure message. `connect()` reports
only "no accept" and the application's `ValueError` sits on `comm.future`, where
the *next* input re-raises it - so the first version passed, failed via
`disconnect()` in a `finally`, and printed a raw `ValueError` with the explanation
overwritten. It now reads `comm.future.result()` before that can happen.

pytest 218 -> **219**, jest unchanged at **97**. No frontend source changed, so
no rebuild.

**Not covered: the bundle.** `static/dist/bundle.js` is what the browser runs, so
if `App.vue` and the committed bundle disagree, the app uses the bundle's copy and
this test is looking at the wrong file. That is item 36's lesson and `deploy.sh`
now rebuilds on deploy, but nothing pins the *committed* bundle to the current
source. Left alone deliberately - it is a second gap, not this one, and closing it
means deciding whether the committed artifact is the contract or a cache.

**Measured since, and the answer is the good one: they agree.** Item 58 rebuilt
the frontend and compared. `bundle.js`, `bundle.css` and `bundle.js.map` are all
byte-identical to the committed copies, so the bundle is current and the build
is reproducible. What is still missing is not drift but the *absence of a check*:
nothing in 237 pytest or 134 jest reads `static/dist/`, so a source edit
followed by a forgotten rebuild would stay green. Whether to pin that depends on
the contract-or-cache question, which is still yours.

**One NUL byte in this file, which had been making it ungreppable.** A badly
written reversion script - the incident recorded two sections above - left
`and\x00not cleanly` at line 2218. `grep` classified all 140 KB of `PLAN.md` as a
binary file and silently matched nothing, which is why several searches during
this and the previous item came back empty and had to be redone with the Read
tool. Removed.

**The check that sentence gave was the wrong one, and item 52 proved it.** I
wrote "Removed; `file` now says ASCII text" and then reported that invariant
for the rest of the sweep - including in items 56 and 57 - on the strength of
`file` alone. `file` still says ASCII text. It is also still wrong: item 52's
copy table introduced two U+00D7 (MULTIPLICATION SIGN), and `file` calls the
file ASCII with them in it. The check that actually distinguishes is a
byte-level count:

    LC_ALL=C grep -cP '[^\x00-\x7F]' PLAN.md      # 0 is the invariant

Now 0, both replaced with `x`. Worth keeping alongside the NUL story:
`file` being clean is not evidence a file is ASCII, and "grep found nothing"
here has now twice meant something other than a negative result.

**That grep does not check for NUL, and I assumed it did.** `\x00` is inside the
`\x00-\x7F` range, so `[^\x00-\x7F]` cannot match it - the pattern is a
non-ASCII check, not a NUL check. `LC_ALL=C grep -c $'\x00' PLAN.md` is worse
than useless: bash strips the NUL from `$'\x00'`, leaving an empty pattern that
matches every line, and it reports the file's line count as a NUL count. The
check that actually answers the question is:

    venv/bin/python -c "d=open('PLAN.md','rb').read(); print(d.count(b'\x00'))"

Now 0. Both invariants are byte-level and both are currently clean; they are
separate checks and the second one above is the only thing that verifies the
first.

### 43. Six negatives around item 42, and the one hole they did find

Item 42 found a gap in a contract class and left the class open. That class is
"a thing the client and the server each wrote down, and nobody compared" - so
it was surveyed rather than assumed, and the survey is the record.

**What was checked, and what each check found.** All mechanical, all against the
live sources:

| # | contract | method | result |
|---|---|---|---|
| 1 | the 7 push payload branches in `App.vue:44-71` | each key the client destructures vs each producer | agree |
| 2 | every `commit`/`dispatch` | string vs `mutations.js` / `actions.js` keys | 19 + 18, none missing |
| 3 | every axios URL | `django.urls.resolve()` | 19 of 19 resolve |
| 4 | `sendingPool`, `receivedMessages` | read anywhere outside `mutations.js`? | no |
| 5 | `state.js` keys | vs mutation writes and `$store.state.` reads | agree |
| 6 | invitation response bodies | `FriendshipAccept/Reject` return `serializer.data` | always a list |

Four of those are worth spelling out, because each is a silent-failure mode
that happens to be closed today rather than one that was designed shut:

- **(1)** `room_delete` ships `data={'room_id': ...}` and `App.vue:51` reads
  `data.data.room_id`; `writing` ships `{user_id, room_id}`; `update_message`
  ships `{message_id, kind}`. All three match. Matching is not enforced by
  anything, though - it is three hand-written pairs that agree.
- **(4)** `state.sendingPool` is a `Map`, and Vue 2 does **not** make `Map` or
  `Set` reactive. That would be a real bug if a component read it in a computed
  and never saw the change. Nothing does - it is bookkeeping, read only inside
  mutations - so it is inert today and would become a bug the first time a
  template grew a `sendingPool.has(...)`.
- **(5)** An undeclared key written by a mutation is non-reactive in Vue 2 and
  fails without a word. There are none, in either direction.
- **(6)** `SET_SENT_INVITATIONS` guards `if (sentInvitations)` before
  `.forEach`; `SET_RECEIVED_INVITATIONS` does not, and accept/reject are the
  two actions that commit to it. It looks like a live bug and is not:
  `FriendshipAcceptAPIView.post` and `FriendshipRejectAPIView.post` both
  `return FriendshipRequestListAPIView.get(self, request)`, which is
  `Response(serializer.data)` - a list, always, `[]` when empty. Both guards
  are dead weight. Recorded so the asymmetry is not "fixed" by someone who
  reads it as a hole.

**The one that was not a negative: the unread axis had never been run.** jest
coverage is the other measurement axis and it had not been used in this project
at all until now:

```
actions.js    3.85% stmts    0% branch   3.7% funcs
mutations.js  50%   stmts   46% branch  33% funcs
every .vue   100%   stmts  100% branch 100% funcs
```

19 mutations, **4 exercised** by `room_message_order.spec.js` and
`failed_send.spec.js`. The three unexercised ones - `ADD_UNREAD_MESSAGES`,
`REMOVE_MESSAGE_FROM_UNREAD`, `REMOVE_ROOM_MESSAGES_FROM_UNREAD` - are the only
things in the app that move the unread badge, and three components read that one
map:

```
User.vue:169        Object.values(unreadMessages).filter(el => el === this.room.id).length
MessagesSection:202 Object.values(unreadMessages).includes(selectedRoom)
SentMessage:78      this.message.id in unreadMessages
```

All three compare **strictly**. `===` means the stored value has to be the same
*type* as `room.id`; both arrive as JSON numbers, so they are. A change that
made either a string empties the badge on a live app with nothing in the console.
And the shape crosses a language boundary unwired, exactly as item 42's URL
did: `ADD_UNREAD_MESSAGES` reads `element.id`/`element.room`, and
`UnreadMessageSerializer` declares exactly `('id', 'room')`.

`tests/unit/unread_axis.spec.js` runs the three mutations over a server-shaped
payload. Four reversions:

| | change | failed |
|---|---|---|
| **R1** | `REMOVE_ROOM_MESSAGES_FROM_UNREAD` clears every room | that test only |
| **R2** | `ADD_UNREAD_MESSAGES` merges instead of replacing | two tests - see below |
| **R3** | `REMOVE_MESSAGE_FROM_UNREAD` deletes one key past the one asked for | that test only |
| **R4** | `ADD_UNREAD_MESSAGES` stores `element.id` where the room id belongs | that test only |

**R2 is not isolating, and is left that way.** It fails "a re-fetch rebuilds the
badge" *and* "an empty answer clears the badge" - two tests asserting one
invariant from two angles, so breaking it breaks both. Forcing isolation would
mean deleting the second test, which would make the number prettier and the
suite weaker.

**A reversion of my own that was not isolating, and should have been caught
first.** R3's anchor was `Vue.delete(state.unreadMessages, message_id);` - which
appears **identically** in `REMOVE_MESSAGE_FROM_UNREAD:127` and
`REMOVE_ROOM_MESSAGES_FROM_UNREAD:133`. `str.replace` hit both, so R3 mutated
two functions and failed two tests. The rerun now asserts
`orig.count(anchor) == 1` before writing anything. Same family as the NUL byte:
a measurement that quietly measured the wrong thing.

The "opening a room" test also builds its state directly rather than through
`ADD_UNREAD_MESSAGES`, so it is about the one mutation it names.

jest 97 -> **102** (19 -> 20 suites), pytest unchanged at **219**. No production
file changed, so no rebuild.

**What this does not close.** Item 42's websocket URL is now pinned from both
ends. The 19 REST URLs, the 7 push payload shapes and the 2 invitation bodies
are checked *once*, by the table above, and nothing stops them drifting
afterwards - the axios URLs in particular are not covered by any test at all,
because resolving one proves only that `urls.py` has *a* matching route, not
that the client's method, query string or body still matches the view. A test
for that is mechanical and would be short. It is not written, because six of
six checks coming back clean is a reason to think the surface is not where the
risk is, and manufacturing coverage for a surface already surveyed is the thing
this file keeps arguing against.

### 44. Mutation testing: the axis that had never been used, and two survivors

Everything to item 43 measures whether lines *ran*. Nothing measured whether the
suite would *notice*. Seventy-nine reversions had each been aimed at a test
already known to exist; none had been aimed at the suite as a whole to see what
it misses. So: eight mutations of the message API surface, full suite each.

| mutation | killed by |
|---|---|
| drop the ascending reversal, `[:10][::-1]` -> `[:10]` | `test_offset_walks_backwards_through_history` |
| offset off-by-one, `id__lt` -> `id__lte` | `test_offset_walks_backwards_through_history` |
| ten most recent becomes five | `test_returns_the_ten_most_recent_in_ascending_order` |
| non-numeric offset silently ignored | `test_a_non_numeric_offset_is_rejected_not_a_crash` |
| **`get_pending_messages` stops acking** | **SURVIVED** |
| room history readable by any signed-in user | `test_cannot_see_another_rooms_messages` |
| `is_owner` always `True` | `test_recent_response_flags_the_author_as_owner` |
| **`get_all_received` always `True`** | **SURVIVED** |

Six of eight, which is a good hit rate for the part of the suite that exists.
**Two survived, and both were silent at 100% statement coverage - and 99% branch
coverage on the file they sit in.**

**Survivor 1: `get_all_received` could return `True` unconditionally and every
test in the project still passed.**
`test_flags_flip_once_everyone_has_received_and_read` is named for the flip and
asserts only the `True` side. No test anywhere asserted `all_received is False`.
`all_received` is what the double tick is drawn from, so the mutation means
every message in the app claims everyone has received it, from the moment it is
sent, and nothing says otherwise.

The `False` case is reachable, but not through the endpoint the sibling test
uses. `/messages/` returns what is pending *for you* and acks it in the same
call, so by the time it serializes you are no longer pending and the flag is
genuinely `True`. What reaches the `False` side is `other` pending while you are
not: both ack paths clear the *requesting* user only, so nothing quietly clears
it first.

`test_a_message_someone_is_still_pending_for_does_not_claim_all_received`.

**Survivor 2 is the more interesting one, because the test that looks like it
covers it does.** `test_pending_messages_are_returned_then_consumed` asserts the
second call comes back empty - yet deleting the ack leaves it green.

There are **two** independent paths that remove you from a message's
`pending_reception`:

```
MessageManager.get_pending_messages   clears you from *every* pending message
RoomSerializer.get_last_message       clears you from *the newest in the room*
```

With one pending message the second does the first's job, so the test proves
*an* ack happened and says nothing about which. The manager's loop only matters
once a room holds **two** pending messages - the serializer cannot reach the
older one at all, because `get_last_message` looks at exactly one message.

`test_every_pending_message_is_consumed_not_just_the_newest`.

This is the first gap in the project that **statement coverage could not have
found and branch coverage could not have found** - both functions are fully
covered and every branch taken. It took deleting a line and watching nothing
change. That is the argument for mutation testing being the axis that was
missing, and it was missing for 43 items.

Both reversions now kill exactly their own test and nothing else:

```
S1  get_all_received -> True            1 failed, 220 passed
S2  get_pending_messages stops acking   1 failed, 220 passed
```

pytest 219 -> **221**, jest unchanged at **102**. No production file changed.

**Not done, and it is the obvious next step:** eight mutations of one file is a
sample, not a survey. `friends/models.py` (335 statements - `add_friend`,
`accept`, `reject`, `cancel`) and `chat/consumers.py` have had none, and the
invitation state machine is what the client's three tabs are built on. That
sweep is worth running rather than speculating about.

### 45. That sweep: thirteen mutations, thirteen kills

Run, because item 44 said to run it rather than speculate. Two files that had
had no mutation testing at all.

**`friends/models.py` - the invitation state machine (4 + 4):**

| mutation | killed by |
|---|---|
| `accept` does not delete the reverse request | `test_both_sent_lists_are_already_empty_after_a_cross_invite_accept`, +1 |
| `accept` sends no signal | `test_accepting_tells_both_of_them_to_refetch_rooms`, +4 |
| `reject` does not set `rejected` | `test_a_rejected_request_cannot_be_accepted`, +14 |
| `reject` does not bust the sender's sent cache | `test_rejecting_reaches_the_senders_list`, +1 |
| re-asking does not clear `rejected` | `test_asking_again_after_a_rejection_puts_the_invitation_back`, +5 |
| re-asking does not clear `viewed` | `test_a_reinvitation_comes_back_unread` |
| `can_request_send` counts a rejected row as pending | `test_can_request_send_ignores_a_rejected_row`, +8 |
| `add_friend` busts the sender's cache, not the receiver's | `test_the_receiver_sees_it_again_as_a_fresh_invitation`, +3 |

**`chat/consumers.py` (5):** anonymous sockets accepted; every user joined one
shared group; a refused socket discarding a group it never joined; `disconnect`
not leaving the group; the push sent without its payload. **Five for five.**

**No survivors.** Thirteen of thirteen, against two for eight on the message API
in item 44. That contrast is the useful part and it points somewhere: the weak
surface was the message API, not the invitation machine or the socket, and item
44 is what closed it. This is also the first evidence in the project that the
`friends` app's vendored state machine is genuinely pinned rather than merely
executed - every one of those mutations is a line whose comment claims a
specific past bug, and each claim now has a test that dies when the line goes.

`friends/models.py` and `chat/consumers.py` are byte-identical after the sweep,
each verified by `read_text() == orig` inside the `finally` of every mutation.
pytest **221**, jest **102**. The reversion counter stays at eighty-one: these
are exploratory probes with no dedicated pin each, and counting them would
inflate a number that means something specific.

### 46. The wire format, swept: eleven mutations and one survivor

`chat/api/serializers.py` is where every field the client reads is *named*, and
it had run in every test in the project without a single line of it being
reverted on purpose. It is the third file item 44 and item 45 named as having
had no mutation testing, and the riskiest of the three: a serializer is not
called from anywhere except a test that asserts its own output.

| mutation | killed by |
|---|---|
| `get_is_owner` -> `True` always | `test_recent_response_flags_the_author_as_owner` |
| `get_all_read` -> `True` always | `test_a_message_someone_is_still_pending_for_does_not_claim_all_received`, +1 |
| `MessageSerializer` stops excluding `pending_read` | `test_message_exposes_exactly_the_expected_fields` |
| `UnreadMessageSerializer` drops `room` | `test_unread_items_name_the_room_they_belong_to` |
| **`CreateMessageSerializer` drops `front_key`** | **survived** |
| `get_last_message` returns the object, not its id | 16 tests |
| `get_last_message` stops acking receipt | `test_viewing_a_room_acks_receipt_but_not_read`, +1 |
| `get_group_name` reads `kind == 2` | `test_group_name_reports_the_other_participant_for_private`, +1 |
| `get_group_name` returns `None` instead of the peer | the same two |
| `get_group_profile` reads `kind == 2` | `test_group_room_profile_exposes_the_group_name`, +1 |
| a group's profile loses `username`/`tagline` | `test_group_room_profile_exposes_the_group_name` |

**Ten of eleven, and the one that lived is the most load-bearing field in the
file.** `front_key` is the only thing joining the bubble you see the instant
you press send to the copy the server sends back: `LINK_MESSAGES_TO_ROOM` takes
its `sendingPool` branch on it (which is what takes the clock icon off),
`mergeMessages` dedupes on it, and `REMOVE_FAILED_MESSAGE` filters the thread by
it (item 10). Nothing in `actions.js`, in `SendForm.vue` or in any of the 25
tests in `test_message_api.py` ever asserts it.

Dropping it from `Meta.fields` is the *quietest* possible break, and that is
what made it survive. `front_key = models.UUIDField(default=uuid.uuid4)`, so a
serializer that does not declare the field does not 400 on a posted one -- it
falls back to a fresh random uuid, and answers 201 as though nothing were
wrong. Every test that posts a `front_key` does it to get a valid payload, and
every one of them reads the message back by room and body. The client's own
copy is then keyed by something the server never saw, so the server's copy
arrives as a *second* message: the thread shows it twice, the original still on
its clock icon, and a refused send takes back a bubble that is not there.

Closed by `test_the_created_message_carries_the_clients_front_key`, which reads
the stored row rather than the response:

```
R  CreateMessageSerializer drops front_key   1 failed, 221 passed
   djchat/chat/_tests/test_message_api.py::test_the_created_message_carries_the_clients_front_key
```

**The harness lied twice, and that is the part worth keeping.** Of the eleven
probes, one produced an `IndentationError` and one had an anchor that did not
match at all - both were counted as kills by a runner that only asks "was the
exit code non-zero?". A mutation that cannot be imported is not a killed
mutation; it is a broken probe wearing a green tick. Both were re-run by hand
with correct anchors (`get_last_message`'s ack call replaced by a no-op
expression rather than by deletion, and the `get_group_name` anchor re-read off
the file - `Read` had wrapped it and my indent was the wrong width), and both
are in the table above as honest kills. The runner asserts `ORIG.count(anchor)
== 1` before writing, which is what caught the second one; it does **not** check
that the mutated file still imports, and it should.

`chat/api/serializers.py` is byte-identical after the sweep, verified by
`read_text() == orig` inside the `finally` of every probe. pytest **222**,
jest **102**.

### 47. You could cancel a request they had already rejected

The guard against accepting your own dismissal has been on the accept endpoint
for a while, with a comment explaining why: a rejected request keeps its row,
so `friendship_requests_received` still holds it. The same is true of
`friendship_requests_sent`, and `FriendshipCancelAPIView.post` read that
relation with no filter at all:

```python
f_request = get_object_or_404(
    request.user.friendship_requests_sent, id=friendship_request_id
)
f_request.cancel()          # -> self.delete()
```

So the sender could cancel by id a request the receiver had already turned
down. `cancel()` deletes the row, and that row *is* the receiver's record of
the dismissal - `rejected_requests` is built from it, and `add_friend` revives
that same row when they are asked again. The receiver's Rejected tab loses the
entry on their next fetch. Answer was 200, no push to anyone, and nothing in
the console.

The reachability is narrow and worth being honest about: `sent_requests` filters
`rejected__isnull=True`, so the Sent tab never renders a Cancel button for a
rejected row. What the sender still has is the id, from the request they sent
themselves. This is an integrity hole, not a live click path.

One line, at the same place accept's already lives:

```python
f_request = get_object_or_404(
    request.user.friendship_requests_sent.filter(rejected__isnull=True),
    id=friendship_request_id
)
```

`test_cannot_cancel_a_request_they_already_rejected` asserts both halves: the
404, and that the receiver's rejected list still holds the row afterwards.

```
R  cancel's rejected__isnull guard removed    1 failed, 222 passed
   djchat/friends/_tests/test_friendship_api.py::test_cannot_cancel_a_request_they_already_rejected
```

pytest **223**, jest **102**. No other behaviour changes: cancelling a pending
row still answers 200 with the sent list, and
`test_cancelling_removes_the_request` and
`test_cannot_cancel_a_request_you_did_not_send` both still pass.

**Checked and deliberately not changed:** `FriendshipRejectAPIView.post` has no
`rejected__isnull=True` either, so a request can be rejected twice. It is
harmless - `reject()` re-stamps the same datetime, re-fires the same signal and
busts the same caches, and every query that reads the row already excludes it -
so the guard there would be a filter that pins nothing. Noted rather than fixed.

### 48. The push payloads, measured, and consistent

Item 42 found one instance of a contract each half keeps to itself - the socket
URL - and said the class was still open "for every other push payload and
response field the client reads". The push payloads are the other half of that
note, so they got the same treatment. Every `group_send` in the tree, against
every branch of `App.vue`'s `onmessage`:

| push | produced by | `data` the client reads | produced |
|---|---|---|---|
| `update` | `MessageViewSet.create` | - | yes |
| `update_rooms` | accept signal, `RoomViewSet.create` | - | yes |
| `room_delete` | `RoomDeleteAPIView` | `room_id` | yes |
| `update_received` | request-created / canceled signals | - | yes |
| `update_sent` | accepted / rejected signals | - | yes |
| `writing` | `RoomWritingAPIView` | `user_id`, `room_id` | yes |
| `update_message` | `remove_user_from_pending`, `mark_as_read` | `kind`, `message_id` | both kinds |

Seven kinds, none unhandled, none unproduced, both `kind` values
(`all_received`, `all_read`) sent by the two methods that own them, and all
three `data` keys matching the consumers that destructure them
(`App.vue:51`, `User.vue:120/126`). `ChatConsumer.chat_message` forwards
`event['message']` and `event['data']` verbatim, so there is no third copy to
drift.

One near miss worth writing down, because it looked like a crash and was not.
Both room-list views build `messages.add(room_data['last_message'])`, and
`get_last_message` returns `None` for a room with no messages - which is every
room created by an accepted invitation, since `Room.get_or_create_private` makes
the row before anyone speaks. `Message.objects.filter(id__in={None})` reads like
`int(None)`. `IntegerField.get_prep_value` returns `None` for `None`
(`django/db/models/fields/__init__.py`, verified in the installed 5.2 rather
than assumed) and the SQL becomes `IN (NULL)`, which matches nothing. Left
alone.

`push_notifications.py` remains what item 14's neighbourhood would call debug
leftovers - a management command whose `help` says "Send push notifications to
clients" and whose payload is `"message": "testeando esto"`. It is reachable
only from a shell and its output matches no branch in `onmessage`, so it does
nothing at all. Deleting it is a one-line change and it is **not** made here:
it is a manual smoke-test of the socket plumbing, which is a real thing to want,
and whether that is worth a committed file is a call, not a bug.

### 49. The export endpoint had no UI at all

`GET /api/v1/rooms/<id>/export?as=json|csv` is built, routed, and covered by
eight tests in `chat/_tests/test_room_export.py` - membership, both formats,
CSV header and quoting, the empty room, and the rule that a download must not
consume pending delivery state. Grepping `frontend/src` **and** `frontend/tests`
for `/export` returned **nothing**. A finished, tested feature no user could
reach, in any build, ever. Three endpoints were in this state; this was the one
whose missing half was pure wiring.

The server was already half-broken for it. `?as=csv` set
`Content-Disposition`, so a link downloads it and the tab stays on the app.
`?as=json` - the default - answered a bare `application/json` `Response`, so a
link **navigated the tab away from the SPA and printed the payload on screen**.
Two formats in one endpoint, two different behaviours, and the broken one is
what you get by leaving `?as=` off. Fixed at the source rather than worked around
in the client:

```python
def _json(self, request, room, messages):
    response = Response(self._payload(request, room, messages))
    response['Content-Disposition'] = \
        f'attachment; filename="room-{room.id}.json"'
    return response
```

That is what makes the frontend half free. The server decides what happens to
the bytes, so the client is **two `<a href>` tags and nothing else** - no axios
action, no blob, no object URL to revoke, no store mutation, no state. The
ladder rung this stops at is 6, and the reason it is allowed to stop there is
that the rung above it already existed.

Two tests, not one. `test_both_formats_are_downloads` is the claim;
`test_downloading_json_still_serves_json` is its control, and it is the one that
does **not** die on reversion - it asserts the body is still JSON and the
Content-Type still `application/json`, which is what stops "fix" being
implemented by breaking the format. Five jest tests: both formats offered
(CSV alone would pass "is there an export link"), the href follows the selection
(the panel is a slide-over that rebinds in place, so a captured room would
download Bob's chat while the panel shows Carol's), the links stay plain
anchors, the panel scrolls, and Delete chat is still there.

**One finding from adding the block, which was the more interesting half.**
`.user-details` and `.user-profile-sidenav` are marker class names with **no
rule anywhere in `src/`** - the panel is `height: 100%` with no `overflow`, so
it already clips on a short viewport. Adding a fourth block to it would have
pushed "Delete chat" out of reach, which is a strictly worse regression than
having no export. One class, and it is the reason the spec has a test for it.

**A comment I had to take back.** `exportUrl` reads `this.roomId`, not
`this.getRoom.id`, and the first version of the comment said `getRoom` is `{}`
until the rooms map holds the row - which would put `undefined` in a URL.
Measuring it: `SET_ROOMS` is additive (`Vue.set`, never deletes), the only
non-null `SET_SELECTED_ROOM` is `UsersSection.vue:37`'s `selectRoom(room.id)`
where `room` comes from `Object.values(state.rooms)`, and `MessagesSection.vue:25`
already reads `state.rooms[selectedRoom].group_name` **unguarded**. So the two
are the same value, the invariant the app already depends on, and the failure
mode was not reachable. The comment now says the true reason.

Five reversions, each killing the test named for it: `_json`'s header
(`test_both_formats_are_downloads`; the control survives, as designed), the
scroll class, one-format-only, a hard-coded room id, and links-stopped-being-links.
The last two are isolating - one test each. pytest **225**, jest **107**.
`npm run build` re-run, and the URL verified *in the artifact* rather than in
the source: `"/api/v1/rooms/".concat(this.roomId,"/export?as=").concat(t)`.

**And a third broken reversion worth recording**, the same shape as item 46's
M7: my runner judged mutants "compiled cleanly" by looking for `SyntaxError`
and `Invalid` in the output, and one mutation left the Vue template
unbalanced. Jest reported `Test suite failed to run` with `Tests: 0 total`, the
guard passed it as clean, and it was not a kill. The guard now rejects any run
with a failed-to-run banner **or** a zero-test summary.

### 50. The only Logout had no keyboard path

`Menu.vue` opened its dropdown on `@mouseover` and closed it on `@mouseleave`,
on a plain `<div>` that is not focusable, wrapping an `<i class="material-icons">`
that is not a control. No `tabindex`, no `role`, no `aria-expanded`,
`aria-haspopup` or `aria-label` anywhere in `src/`. And the dropdown is `v-if`'d,
so **while it is closed the Logout link is not in the DOM to be tabbed to** -
there is nothing to reach, not merely nothing to press.

It is the only logout in the app. `UsersSection.vue:25` renders it under
`width < 768` and `MessagesSection.vue:39` always, so on a phone a hover is the
only gesture there is, and on desktop the keyboard path is simply absent. Items
38, 39 and 40 walked the invitation row, the room list and the focus ring and
never went near it.

```html
<div class="mr-3 dropdown"
     @mouseover="showContext = true"  @mouseleave="showContext = false"
     @focusin="showContext = true"    @focusout="onFocusOut"
     @keydown.esc="showContext = false">
  <button class="cursor-pointer dropbtn" aria-label="Account menu"
          aria-haspopup="true" :aria-expanded="showContext ? 'true' : 'false'">
```

`focusin` is the load-bearing part. Hover cannot open anything for a keyboard,
and the `v-if` means there is nothing to tab to until something opens it - so the
menu has to open *on the way in*. That also repairs touch for free, because
tapping a button focuses it. `mouseleave` is kept: the path the menu had before
is still the best one for a mouse, and replacing it would be a regression
rather than a fix. Six reversions, four of them isolating.

**The trap in the obvious fix, and the test that missed it.** `focusout` fires
for the trigger too, so `@focusout="showContext = false"` snaps the menu shut
the instant you tab from the button onto the only link it contains - a keyboard
path that dies one step in, and looks fine. The guard is a `relatedTarget`
check against the container.

My first version of that test called `wrapper.vm.onFocusOut(...)` directly, and
**it passed the mutation it existed to catch** (`10 passed, 10 total`). The
method is still on the vm whether or not the template binds it, so the test
pinned the method and not the wiring - the same method-versus-binding hole as
item 42, in a different shape. It now dispatches a real `FocusEvent` off the
trigger; that mutation fails `1 failed, 9 passed`.

**Two spec bugs worth not repeating**, both found by the tests failing *after*
the fix rather than before it. Vue 2 key modifiers prefer a non-empty `key` and
compare it hyphenated against the built-in name `esc`, so `key: "Escape"` does
not match `.esc` and the handler never fires - jsdom also ignores `keyCode` in
the `KeyboardEvent` init dict, hence `Object.defineProperty`. And `focusin` and
`keydown` bubble child to parent, so dispatching them on the component's root
`.menu` div never reaches a handler bound on the inner `.dropdown`.

**A second suite broke, which is the more interesting half.** `keyboard_reach.spec.js`
mounted `MessagesSection` unstubbed and did `wrapper.find("button")`, under a
comment saying *"Nothing else in MessagesSection is a button, so this is
unambiguous."* Giving the menu a real `<button>` made that sentence false, and
`find("button")` silently resolved to the menu - 200 lines above the go-to-bottom
link in the template - so two tests asserted against the wrong element with no
error anywhere. Fixed by stubbing, which makes the assumption true by
construction rather than by what the subtree happens to contain today.

While fixing it: `stubs: { menu: true }` does **not** stub it. `Menu` is
registered under the PascalCase key and vue-test-utils 1 matches stub keys
against that, so the lowercase key silently matched nothing - `mountSection`'s
own stub proved it. `mountList` above had carried the same dead stub since item
39; both are now `Menu`.

pytest **225**, jest **117**. Bundle rebuilt, and the trigger verified *in the
artifact*: `"aria-haspopup":"true","aria-expanded":t.showContext?"true":"false"`.

### 51. `POST /api/v1/rooms/` had no caller

`RoomViewSet.create` and `CreateRoomSerializer` (`kind`, `participants`,
`group_name`) have been wired since the first commit and covered by
`test_room_api.py`. Nothing called them: `store/actions.js` POSTed to
`/rooms/{id}/writing`, `/read` and `/delete` and nowhere else. So the one room
kind you can only get by asking for one could not be made - a private room
appears the moment somebody who knows you messages you, and a group appears the
moment somebody adds you, and the app had no way to do the second thing. Unlike
item 49 this was not a wire-up; it needed a name field and the first multi-select
in the app.

**Measured before writing any of it, and the backend needed nothing.** Three
probes against `RoomViewSet.create`: duplicate participants `[other, other]`
came back 201 with two members (Django's M2M `.set()` dedupes); a 256-character
`group_name` came back 400 on `max_length=255`; the author listed explicitly
came back 201 with `[1, 2]`, because `create` appends them when missing. Invalid
`kind` is refused by the model's `choices`. So the client never needs its own id
in the payload, and a separate client-side cap would have been a second source
of truth rather than a safety net.

**The constraint that decided the design: there is no user-list endpoint.**
`UsersAPIView` requires `?email=` and answers with exactly one account,
deliberately without `tagline`. So there is no list of people to offer, and the
picker is `state.users` - everyone the app has actually seen, which is everyone
whose messages are in a room I am in. That was put to you as a decision and
answered: *people you already chat with*. No backend change, no new endpoint, no
new power granted.

The picker excludes me (`state.userProfile.id`), because my own messages carry
my id and offering yourself as someone to add is a row that cannot fail -
`RoomViewSet.create` dedupes it, so nothing downstream would have complained. And
it sorts: `state.users` is keyed by id in insertion order, which is arrival
order, and a picker that reshuffles between visits is one people tick the wrong
row in.

```js
createGroup(none, { group_name, participants }) {
  ...
  axios.post("/api/v1/rooms/", { kind: 2, group_name, participants })
```

`kind: 2` is load-bearing and invisible: `kind: 1` builds a *private* room
instead, which the view then refuses unless the list has exactly two entries - so
a group of three fails with "Private chats must have exactly 2 participants.", a
message about a chat kind nobody asked for. And there is **no commit after the
POST**, because `RoomViewSet.create` already pushes `update_rooms` to every
participant including the author, and `App.vue:48` already answers it with
`fetchRooms`. The group arrives in the sidebar on its own.

Four files: the action, `rooms/NewGroupModal.vue`, a `<button>` in
`UsersSection.vue`'s search panel that emits `group-action`, and
`Home.vue` mapping that to `$refs["new-group-modal"].open()` - the same shape as
`invite-action` -> `openInvitationModal`.

**Two rules deliberately not mirrored in the client.** There is no "name
required" check and no "pick at least one person" check, and the Create button
is never disabled. The server answers both with a sentence
("Group rooms must have a name.", "There must be at least one another
participant.") and the modal renders `response.data.detail` as-is. Mirroring the
rules would mean two places to keep in step with `RoomViewSet.create` and no
better message than the one already there; a disabled button would be worse,
since it explains nothing about why.

**My third method-versus-wiring test, and it is now a family.** The stale-error
test I wrote first asserted that `error` was not left over from a previous
attempt - by reading its value *after* a failing attempt. The mutation it was
written for is deleting `this.error = ""` from the top of `create()`, and it
**passed** (`0 failed`): the catch writes `error` either way, so "cleared first"
and "overwritten later" are indistinguishable from the value afterwards. The
window that matters is between pressing Create and the answer arriving, so the
dispatch now never settles until the assertion has run. That is the same mistake
as item 50's `onFocusOut` test and item 42's method-versus-binding one - three
separate instances, all "the test observes the result and calls it the
behaviour".

**One mutant is deliberately split across two runners.** Raising
`maxGroupName` to 500 is killed by `test_the_group_name_cap_matches_the_model`
and **survives jest**, which is the intended division: jest has no Django and can
only pin that `maxlength` is *bound* to the number, so
`send_form_maxlength.spec.js` pins the binding and pytest pins the number. The
control beside it - a name at exactly the cap still sends - must survive a cap
that is too generous, and does.

Eight reversions, all killed, each file restored byte-identical. Bundle rebuilt,
and the wiring verified *in the artifact*: `post("/api/v1/rooms/",{kind:2,...})`,
`"group-action":t.openNewGroupModal`, `$refs["new-group-modal"].open()`, and
`.filter(function(e){return e.id!==t})`.

**Limits, stated.** There is no end-to-end test here - jest cannot make the
request and pytest cannot see the modal, so the seam between them is the payload
assertions in `describe("the action")`. The `update_rooms` push that makes the new
group appear is this feature's one dependency on the socket, and it is not
exercised by anything in this file: if the WebSocket is down when a group is
created, the server has the room and the sidebar does not, until a reload. That
is the app's existing behaviour for every push, not something this feature
introduced, and the fix belongs in the socket layer rather than here.

pytest **226**, jest **134**.

### 52. Nine copies of the room-kind numbering, and the one nobody compared

The plan records one class as still open: *"a contract each half kept to itself
and nobody compared"* - item 42's shape, the socket endpoint written down twice
with nothing tying the copies together. Item 51 shipped a client that posts a
literal `kind`, so that class had a fresh instance in it. Swept by measurement.

**The sweep is mostly a negative, and the negative is worth as much as the
positive.** `Room.RoomKind` says `PRIVATE = 1, GROUP = 2`, and those two numbers
appear as bare literals in eight more places:

| copy | where | pinned by |
|---|---|---|
| the enum | `models.py:91-92` | the copies below, not itself |
| `PRIVATE`/`GROUP` | `conftest.py:10-11` | moving it *with* the enum still failed 5 |
| `if (kind == 1)` | `roomViews.py:309` | the private-create rules |
| `elif (kind == 2)` | `roomViews.py:322` | `test_group_requires_a_name`, `..._blank_name_...` |
| `room.kind == 1` | `roomViews.py:48` | **3 tests**, incl. `test_deleting_a_group_room_keeps_friendships` |
| `obj.kind == 1` x2 | `serializers.py:62,71` | **2 each** |
| `'kind': 2` x3 | `test_consumer.py` | themselves |
| `kind: 2` | `actions.js:272` | **nothing** |

I expected this to be the item 44 shape - a pile of copies with nothing tying
them together - and the measurement said otherwise for seven of the eight. Mutating
each branch in turn is killed every time, often by a test that reads as though
it were written for something else: flipping `RoomDeleteAPIView`'s `room.kind == 1`
(which is what decides whether deleting a chat also removes the friendship) is
caught by `test_deleting_a_group_room_keeps_friendships`, not by any test about
friendships being deleted.

**The eighth was not.** Renumbering GROUP *consistently* - the enum, `conftest`,
`roomViews.create`'s branch and `test_consumer.py`'s three literals, all four
files moved together, which is exactly what a careful developer does - gives:

```
pytest rc=0    226 passed
jest           0 failed / 134 total
```

Both suites green. Meanwhile `createGroup` is still posting `kind: 2`, `2` is no
longer in the model's `choices`, and **every group created from the UI comes back
400**. Nothing in this repository is red. That is item 42 exactly, and it is the
only one of the eight copies that no test on either side can reach: `create_group.spec.js`
asserts `kind: 2` against a literal it cannot see the serializer through, and
only three Django tests read a frontend file at all (the two caps and `App.vue`'s
socket URL) - nothing reads `store/actions.js`.

**The fix is two tests**, in the `test_the_client_cap_matches_the_body_limit` idiom
already in `test_message_api.py`: read `actions.js` and assert the POST path is
`reverse('room-list')`, and that the body's keys are exactly
`CreateRoomSerializer.Meta.fields` with `kind` equal to `Room.RoomKind.GROUP`.
Split in two on purpose - where it goes and what is in it are separate
contracts, and each mutation kills only its own.

The coordinated mutation is now `1 failed, 227 passed`: the payload test, and
nothing else in the repository. Which is the whole claim - it was the one number
the two halves held separately.

**Deliberately not doing.** Replacing the seven server-side literals with
`Room.RoomKind.PRIVATE`/`GROUP` would make the numbering exist once instead of
eight times, and it is the better shape. It is also a no-op: every one of them is
already pinned, so it buys no behaviour and only adds diff. The copies that
*mattered* is the one copy nobody compared, and that is closed.

pytest **228**, jest **134**. No frontend source changed, so the bundle was not
rebuilt - the reversions mutated `actions.js` and restored it byte-identical.

### 53. The activity chart's response, and the two keys nobody compared

The item-42 sentence says the class is open *"for every other push payload **and
response field** the client reads."* Item 52 closed the request side (`kind`).
This is the response side, and it has the same shape.

`RoomActivityAPIView` (`chat/api/roomViews.py:127`) returns five keys.
`fetchRoomActivity` commits `response.data` untouched - `SET_ROOM_ACTIVITY` is a
bare `state.roomActivity = activity` (`store/mutations.js:165`) - so
`ContactProfile.vue` reads the server's keys verbatim. Six are read: `room_id`,
`days`, `total` and `peak` in the template, `per_day` in `getBars`, `count` per
row. Four were already pinned by the count assertions in `test_room_activity.py`
(`per_day`, `date`, `count`, `total`, `peak`). **Two were not: `room_id` and
`days`.**

Renaming either on the server survives everything, and both fail silently:

| key | who reads it | what breaks |
|---|---|---|
| `room_id` | `getActivity`'s stale-response guard | `activity.room_id` is `undefined`, `undefined !== this.getRoom.id` is true for every room, so `getActivity` returns `null` always: the chart never draws, and the panel says "No messages in this chat yet" above a chat that has messages. The guard that exists to stop one room's bars appearing under another's name is the thing that breaks. |
| `days` | the summary line, the `aria-label`, the left axis | "12 messages in the last undefined days", three times. |

Measured, before the fix - pytest (`test_room_activity.py` plus
`test_room_api.py`) **and** the whole jest suite, each in turn:

| reversion | pytest | jest |
|---|---|---|
| `'room_id'` -> `'room'` | 52 passed | 134 passed, 134 total |
| `'days'` -> `'window'` | 52 passed | 134 passed, 134 total |
| inert control (a comment) | 52 passed | - |

Nothing in this repository is red. jest cannot reach it by construction:
`room_activity_chart.spec.js` builds its payload from `activityFor()`, so it
asserts the keys against itself and never loads the server.

**The fix is one test**, `test_the_response_carries_every_key_the_chart_reads`:
extract the keys the component reads (`(?:getActivity|activity)\.`) out of
`ContactProfile.vue` and assert every one of them is in the response. The
`assert read` above it is the other half - a rename of the computed itself would
leave an empty match and the assertion would pass on nothing, the same trap as
`maxlength` bound to an undefined number.

Each reversion now kills exactly its named test and nothing else:

| reversion | result |
|---|---|
| `'room_id'` -> `'room'` | 1 failed, 7 passed - the seam test |
| `'days'` -> `'window'` | 1 failed, 7 passed - the seam test |
| inert control | 8 passed |

**Not doing:** pinning the response to *exactly* those five keys. item 52's
payload test compares equal because `CreateRoomSerializer.Meta.fields` is the
accepted input set - a set that means something. A response key the client
ignores is harmless, and a hard equality would turn every future diagnostic field
into a test failure.

pytest **229**, jest **134**. No frontend source changed, so the bundle was not
rebuilt.

### 54. `sendMessage`'s three keys, and the two that 201

Same class as items 52 and 53, on the endpoint the whole application exists for.
`sendMessage` (`store/actions.js:73-77`) builds `{room, body, front_key}`;
`CreateMessageSerializer` accepts exactly those three; nothing compared them.

**Two of the three mutations succeed.** That is the whole reason this is worth
pinning, and it took measuring the serializer rather than assuming it:

```
CreateMessageSerializer().fields -> {'room': True, 'body': False, 'front_key': False}
Message defaults                 -> {'room': NOT_PROVIDED, 'body': '', 'front_key': uuid4}
```

| mutation | what the user gets |
|---|---|
| `room` -> `roomId` | **400**, `room` is required. `REMOVE_FAILED_MESSAGE` pulls the optimistic bubble back. The loud one. |
| `body` -> `text` | **201.** `body` is optional and defaults to `''`, so the request succeeds, stores an empty message and `MessageViewSet.create` broadcasts it to every participant. The text the user typed exists only in the bubble on their screen. No error, anywhere. |
| `front_key` -> `clientKey` | **201**, with the model's `uuid4`. `front_key` is the only thing joining your bubble to the server's copy, so the two never match and `sending: true` is never cleared. |

The `body` case is the one to sit with. This is not a chart or a cap: it is the
one field the user supplies, and the server's answer to losing it is a silent
empty message.

**The `front_key` half was already half-pinned, from the other side.**
`test_the_created_message_carries_the_clients_front_key` exists because dropping
`front_key` from `Meta.fields` is exactly the defect its docstring describes -
and it catches that, and cannot catch the client stopping *sending* it. Two
halves of one contract, each pinned alone, which is item 42's shape again.

Measured, before the fix - each mutation in turn, the whole suite, pytest **and**
jest:

| mutation | pytest | jest |
|---|---|---|
| `room` -> `roomId` | 229 passed | 134 passed, 134 total, exit 0 |
| `body` -> `text` | 229 passed | 134 passed, 134 total, exit 0 |
| `front_key` -> `clientKey` | 229 passed | 134 passed, 134 total, exit 0 |
| inert control (a comment) | 229 passed | - |

jest imports `store/actions` in three specs and none of them looks at this
payload: `send_form_maxlength.spec.js` asserts the cap, `create_group.spec.js`
the group post, `email_lookup_encoding.spec.js` a query string.

**The fix is one test**, `test_the_client_send_payload_matches_the_serializer`,
mirroring item 52's. It needs a different extractor, and the reason is worth
writing down: item 52's `post("...", {...})` regex **cannot see this payload at
all**, because `sendMessage` assigns the literal to `payload` and posts the
variable. So the test matches the literal and reads two shapes from it - the
shorthand keys (`room,`) and the conditional spread
(`...(front_key ? { front_key } : {})`) - because a message sent without a
`front_key` carries two keys and one sent with it carries three. Three `assert`s
that the extraction found something, or a rename of the variable would leave it
passing on nothing.

Each reversion kills exactly the named test and nothing else:

| reversion | result |
|---|---|
| `room` -> `roomId` | 1 failed, 25 passed - the seam test |
| `body` -> `text` | 1 failed, 25 passed - the seam test |
| `front_key` -> `clientKey` | 1 failed, 25 passed - the seam test |
| inert control | 26 passed |

pytest **230**, jest **134**. The reversions mutated `actions.js` and restored it
byte-identical, and the frontend is unchanged, so the bundle was not rebuilt.

### 55. `patchUserProfile`, and the pin that was on the wrong side

The last entry on item 42's open list. Measured, and the answer is neither a
yes nor a no - it is a pin that looks like it closes the seam and does not.

`profile_save.spec.js:42` asserts

```js
expect(dispatch).toHaveBeenCalledWith("patchUserProfile", { tagline: ... })
```

a **literal**. So renaming `UserProfile.vue`'s key to `bio` alone *is* caught -
the only seam in this sweep where that was true. But the literal is pinned
against itself: the client and its own test agree, and the serializer is a third
party neither can see. Renaming it in both, which is exactly the "make these
consistent" edit a careful developer makes, is:

| mutation | pytest | jest |
|---|---|---|
| `UserProfile.vue` only | 230 passed | **1 failed**, 133 passed |
| `UserProfile.vue` **+** `profile_save.spec.js` | 230 passed | 134 passed, 134 total, exit 0 |
| inert control | 230 passed | 134 passed, 134 total, exit 0 |

And the failure is silent end to end. `tagline` becomes a key DRF drops;
`CustomUser.tagline` is `blank=True, default=''`, so the PATCH **200s**;
`patchUserProfile` resolves; `UserProfile.patchUserProfile` runs
`showSuccessAlert()`. The user is told their profile was saved and it was not -
item 54's dropped `body`, one field smaller.

**The fix** is `test_the_client_patch_only_sends_fields_the_server_applies`:
read the keys out of `UserProfile.vue`'s dispatch and assert they are a subset of
what `UserSerializer` will actually apply. Two things about that are worth
writing down, because both are places a lazy version of this test goes wrong:

- **The extractor reads the component, not `actions.js`.** `patchUserProfile`
  there takes the body as a `payload` argument and posts the variable, so the
  object literal is built by its one caller. Same reason item 54's extractor had
  to differ from item 52's.
- **Subset, not equality.** `Meta.fields` also holds `id`, `username`, `email`,
  all `read_only`; demanding the client send those asserts the opposite of what
  `test_username_cannot_be_edited` exists to pin. And a writable field the client
  *cannot* reach is a feature not built, not a defect - equality would go red the
  day someone adds a column without a box for it. The claim worth making is the
  one the defect violates.

Both reversion shapes now die on the named test and nothing else:

| reversion | result |
|---|---|
| component + spec (coordinated) | 1 failed, 15 passed - the seam test |
| component only | 1 failed, 15 passed - the seam test |
| inert control | 16 passed |

**A negative, and a bigger one: `/me`'s response `id` is not open.** Dropping
`'id'` from `UserSerializer.Meta.fields` - which the client reads in
`NewGroupModal.vue:104`, as the `me` it filters itself out of the candidate list
by - is killed by **four** tests, across three endpoints:

```
test_private_room_exposes_the_other_participants_profile
test_pending_response_carries_the_related_rooms_and_users
test_recent_per_room_returns_its_room_and_the_message_authors
test_json_export_carries_the_room_its_participants_and_messages
```

Only the first looks like it is about `id`. The other three pin a *different*
endpoint's users block, which is item 52's finding restated: the pins that save
you are usually the ones written down for something else.

**And the sweep's last entry is a negative too.** Every push payload in
`test_consumer.py` is asserted by **exact dict equality** - `update_message`
(`kind`, `message_id`), `room_delete` (`room_id`), `writing` (`user_id`,
`room_id`), and `update` / `update_rooms` / `update_received` / `update_sent`
with an empty `data`. Equality against the whole payload means a renamed key
dies immediately, so there is no survivor to hunt and no test worth writing.
That closes all three entries the plan listed as open.

**A broken measurement of my own, recorded because the plan has been recording
them.** My first harness for the coordinated mutation wrote each mutation and
then restored it *inside* the same helper, before pytest ran - so it reported
`230 passed` and `134 passed` for two cases that had never been mutated, and I
briefly recorded `/me`'s `id` as an open seam on that basis. It was not: the
corrected run kills it four times over. The tell was that a mutation I was
confident would die did not, and the fix was `assert path.read_text() !=
before[path]` - the same "the write must have landed" check the earlier
harnesses had and this one had lost.

pytest **231**, jest **134**. The reversions mutated `UserProfile.vue`,
`profile_save.spec.js` and `users/api/serializers.py` and restored all three
byte-identical, so the frontend is unchanged and the bundle was not rebuilt.

### 56. The three GET handlers nothing had ever executed

The plan's own backlog is exhausted - items 1-4 are done or declined, and what
is left (the read/unread axis, the `Message.body` cap, the room list's meaning,
the two dead files) is a decision the plan explicitly reserves for you. So this
item opens a **different measurement axis** instead: coverage.

Coverage asks a question the four mutation sweeps structurally cannot.
Mutating never-executed code "survives" trivially - the code never runs, so
the mutation cannot fail - which means every survivor count in items 44-46 was
measured over executed lines only and was blind to this whole class by
construction. `pytest-cov` is not installed, but `coverage` 7.16.2 is, so:

    COVERAGE_FILE=/tmp/.cov coverage run --source=djchat \
      --omit='*/migrations/*,*/tests/*,*/_tests/*,*/node_modules/*' -m pytest
    coverage report --show-missing

96% overall, and **exactly three statements in the whole application had never
executed**: `friends/api/views.py:65, 86, 100`. One `get` per mutating view,
each a one-line delegation:

    def get(self, request, friendship_request_id, format=None):
        return FriendshipRequestDetailAPIView.get(self, request,
                                                  friendship_request_id=friendship_request_id)

They are routed (`friends/api/urls.py:26-33`), so `/accept/<id>`,
`/reject/<id>` and `/cancel/<id>` answer **GET as well as POST** - and nothing
in this repository, client or test, ever asks them to. The client only POSTs:
`acceptFriendRequest`, `rejectFriendRequest` and `cancelFriendRequest` are the
sole callers of the three URLs.

**So: no defect. The behaviour is correct.** The delegation inherits the
detail view's ownership filter, so no information leaks, and a GET accepts
nothing. This is a coverage gap, and I am recording it as one rather than
manufacturing a bug to justify a test.

But it is a gap with a real hazard, and that is worth a pin. The URL says
*accept*; a GET is what a link prefetcher, a crawler, or a pasted address bar
sends; and a 200 from `/accept/5` reads like an acceptance that never happened.
The natural cleanup - deleting the three `get` handlers so the URLs answer 405
and the affordance stops lying - is **your call**, and is not made here. What
is pinned is only the safety property, in the direction that matters:

    a GET on a mutating friendship URL must not mutate anything,
    and must not show you a request you are not a party to.

Two tests, three params each (`accept`, `reject`, `cancel`), in
`friends/_tests/test_friendship_api.py`.

**Both failed on their first run, and both failures were my bugs, not
defects.** Worth recording because the assertions looked like findings:

- `test_..._returns_the_request_and_changes_nothing` asserted the request was
  still in `received_url()` - read with `auth_client`, which is `user`, the
  **sender**. `add_friend(user, other)` sends it *to* other, and
  `received_url()` answers for the caller's own inbox, so alice's list is
  correctly `[]`. The assertion now goes through `as_bob`, who is the receiver.
- `test_..._will_not_show_you_someone_elses_request` used `as_bob` as the
  stranger - but `as_bob` **is** `other`, the request's own receiver, for whom
  a 200 is the correct answer. It now uses a genuine third party
  (`make_user('carol')`, `make_user('dave')`), the same shape as
  `test_cannot_read_a_request_you_are_not_a_party_to`.

**Reversions, one at a time, each against the six new cases only:**

| mutation | killed |
|---|---|
| accept's `get` calls `.accept()` | `...changes_nothing[accept]` |
| reject's `get` calls `.reject()` | `...changes_nothing[reject]` |
| cancel's `get` calls `.cancel()` | `...changes_nothing[cancel]` |
| detail view's ownership filter widened to `.objects.all()` | all three `...someone_elses_request` |
| delegation line re-wrapped (inert) | **nothing - survived, as required** |

Each of the first three kills exactly its own param and nothing else, which is
the isolating property: the three tests do not stand in for each other. The
fourth kills all three 404 cases and no "changes nothing" case - the two claims
are genuinely independent.

**A second broken measurement of my own.** My first inert control was
`FriendshipRequestDetailAPIView().get(self, request, ...)`, on the theory that
instantiating the view was equivalent to the unbound call. It is not: that is a
*bound* method, so `self` inside `get` is the new instance and the outer `self`
lands in the `request` parameter - `request.user` raises `AttributeError` and
all six tests died. A control that kills everything proves nothing. Replaced
with a pure line-wrap, which survived.

**Coverage after, which is the claim this item rests on:**
`friends/api/views.py` is at **100%** (was `65, 86, 100` missing), total **98%**,
26 statements missed. Every one of the remaining 26 is named here rather than
left as a number:

- `friends/api/test.py` - 10 lines, all of them vendored upstream helpers
  (`class login`, `create_user`, `assertResponse200/302/403/404`). Dead
  vendored scaffolding that came with the tutorial this app was built from;
  not a defect, and not this plan's to delete.
- `friends/models.py` - 11 lines: four `__str__`/`__repr__` (113, 451, 556,
  666), four unreached branches of friend/follow/block properties (414-415,
  424, 532, 638), and **two `raise ValidationError` guards that no test
  exercises** - 561 `Users cannot follow themselves.` and 671 `Users cannot
  block themselves.`
- `chat/models.py:57` - one `__str__`.
- `friends/tests.py`, `friends/views.py`, `users/tests.py`, `users/views.py` -
  one statement each, Django 1.x boilerplate the app no longer routes.

The self-follow and self-block guards are the only ones of the 26 that are
validation at a trust boundary rather than debug helpers, and they are the
next real lead.

pytest **237** (231 + the 6 new cases), jest **134**. No production file was
modified for this item, so nothing was rebuilt.

### 57. The follow/block axis has no walls, and the import that hid it

Item 56 closed by naming a next lead: the two `raise ValidationError` guards at
`friends/models.py:561` and `671` - "users cannot follow/block themselves" -
because they are the only 2 of the 26 remaining uncovered statements that are
validation rather than debug helpers. Three measurements, and the first one
says the lead is worth nothing.

**1. The negative, which closes item 56's lead.** The entire axis is
unreachable, and not by a little:

- `Follow` and `Block` were imported at `friends/api/views.py:11` and used
  **nowhere** in that file.
- No URL, no view, no serializer, no frontend source, and **zero** references
  in the committed `static/dist/bundle.js`.
- `git log -S add_follower -- djchat/friends/api/` and the same for
  `add_block` are both **empty**: the endpoint never existed. This is not a
  feature that was removed, it is one that was never built.

So those two guards are not untested validation at a trust boundary. They
guard a door with no walls around it, and the only things that call them -
`Follow.objects.add_follower` and `Block.objects.add_block` - are *already*
tested for exactly this rule by `test_cannot_follow_yourself` and
`test_cannot_block_yourself`. The `save()` overrides are a second line of
defence under a first line that no request can reach. Writing tests for them
would be manufacturing coverage of unreachable code, so this is **recorded and
declined** - the same verdict item 4 gave `GET /api/v1/friends`.

**2. The real find, and it is not the guards.** The reason the axis looked
alive was one import line. And it is not a one-off: a 40-line AST scan of
every production `.py` under `djchat/` (skipping migrations, tests and
entry points) found **16 imported names that the file never references**. Five
of them sit in live production code and are now gone:

| file | dropped |
|---|---|
| `friends/api/views.py:11` | `Follow`, `Block` |
| `friends/api/serializers.py:5` | `Friend` |
| `users/api/views.py:3` | `viewsets` |
| `users/models.py:3` | `settings` |

**16 -> 11.** Each of the four was verified with `grep -cw` returning exactly
`1` - the import line and nothing else - so the deletions are provably
behaviour-free and the 237-test suite is the whole of the check.

The 11 left are left on purpose:

- 6 in `friends/api/test.py` and 4 in the Django 1.x stubs (`friends/tests.py`,
  `friends/views.py`, `users/tests.py`, `users/views.py`) - dead vendored
  tutorial scaffolding the plan already reserves for you.
- 1 in `push_notifications.py`, a file already on your deletion list.
  Tidying an import in a file you are about to delete is churn.
- `from __future__ import unicode_literals` in `friends/models.py` - a Python 2
  relic and a no-op on 3, but it is a **compiler directive, not an unused
  name**, and my scanner flagging it is a category error on my side. Removing it
  is a different kind of edit from the other four.

**3. Checked on the way past, and negative: no stale-cache defect in
`are_friends`.** Its two cache branches (lines 421 and 423) have never
executed, and the reason is a direct consequence of item 4's decline. The
`friends` cache has exactly one writer in the whole app -
`friends/api/views.py:26`, `GET /api/v1/friends` - and nothing calls it, so
`are_friends` always falls through to the database. Cold, but **correct**:
`add_friend` busts both sides (lines 143-144) and `remove_friend` does too
(409-410), so no stale read is reachable even if the endpoint were wired.

Its twin `is_blocked` got exactly this treatment after a real cache-prefix
bug - `test_is_blocked_serves_from_the_warmed_cache` exists because
`is_blocked` used to read the `blocks` prefix, which nothing ever writes.
`are_friends` needs no equivalent for correctness today, and a test asserting
"this cache is never populated" would go red the day the friend list is wired,
which is a feature and not a regression.

**No test was added for this item, and that is a decision rather than an
oversight.** Every claim above is either a negative or a provably inert
deletion. The only testable version of "the follow axis does not exist" is an
assertion that a feature must not exist, which is policy - and policy here is
yours, not this plan's.

pytest **237** (unchanged), jest **134** (unchanged). No frontend source was
touched, so the bundle was not rebuilt.

### 58. The committed bundle is exactly in sync, and the build is reproducible

Item 42 left this open and nobody had ever checked it: `vue.config.js:9` sets
`outputDir: "../static/dist/"`, the bundle is a committed artifact, and every
frontend source fix is "a no-op until `npm run build` runs" - which reads like
an admission that it might lag. **It does not.**

Measured, not assumed - a fresh build redirected off the committed path, then
`cmp` against what is committed:

    cd djchat/frontend
    NODE_OPTIONS=--openssl-legacy-provider ./node_modules/.bin/vue-cli-service \
      build --dest .drift-check

| file | fresh build | committed | |
|---|---|---|---|
| `bundle.js` | `63640b90...` | `63640b90...` | **identical** |
| `bundle.css` | `c8426023...` | `c8426023...` | **identical** |
| `bundle.js.map` | `4f942295...` | `4f942295...` | **identical** |

All three byte-for-byte, so two things follow and the second is the bigger one:

1. The committed artifact is **not stale**. Every source fix from items 49-55
   is in the bundle the browser actually runs.
2. **The build is reproducible.** A fresh build, today, on this machine, from
   the tree as it stands, reproduces the committed artifact exactly - including
   the 1.5 MB source map, which no amount of hand-editing would have kept in
   sync. That is much stronger than "it looks current".

`--dest` rather than the default is what made this safe to measure: a plain
`npm run build` overwrites a committed file. Every artifact was confirmed back
at its session-start md5 afterwards.

**And the finding is the shape of the gap, not its absence.** The bundle is in
sync today; what is missing is that *nothing would notice if it stopped being*.
237 pytest and 134 jest read `frontend/src` and never `static/dist/`. Edit a
component, forget to rebuild, and all 371 stay green while production runs last
month's code. That is item 42's shape again - a contract each half kept to
itself and nobody compared - except the halves here are a source tree and its
own compiled output.

**No check added, because the shape of the check is your decision, not a defect
to fix.** There are only two honest ways to pin it, and which is right depends
on the question item 42 left open:

- If the bundle is **the contract**: there is nothing to pin. It is in sync and
  reproducible, and the enforcement is a CI step that rebuilds and diffs -
  infrastructure, not a test.
- If the bundle is **a cache**: stale output is then a real failure mode, and
  the check is either a test that rebuilds and compares (slow - it drags webpack
  and node into the pytest environment) or a content hash of `frontend/src`
  recorded at build time and pinned by a test, which is new machinery.

Both are build-pipeline work. Inventing either now would be answering your open
question for you, so the measurement stands as the prerequisite and the decision
stays yours.

**One trap this measurement walked into, recorded because the next person will
too.** `webpack-bundle-tracker` writes `./webpack-stats.json` relative to **cwd**,
not to `outputDir`, so `--dest .drift-check` left the committed
`frontend/webpack-stats.json` full of absolute `.drift-check` paths even though
the build output itself was redirected. Restored by rewriting that path prefix,
and verified byte-identical to the pre-build md5 `bb46d1a3...` **before** writing
rather than after. Anyone repeating this should either restore that file or run
the real build.

Also recorded so it is not mistaken for a finding: the build emits a 257 KiB
entrypoint against webpack's 244 KiB advisory. Not a defect, and not this
plan's to tune.

pytest **237**, jest **134**, both unchanged - no source file was modified. The
bundle was **not** rebuilt, because it did not need it: that is the finding.

### 59. Every endpoint's authentication requirement, swept at once

Items 32 and 47 found authentication defects one endpoint at a time, each time
because somebody was looking at that endpoint. Nobody had ever enumerated every
registered route and asked all of them the same question. Measured first, from
`get_resolver()`:

| group | count | |
|---|---|---|
| plain Django routes | 74 | 59 admin, 12 `django.contrib.auth.urls`, DRF's own `login/` and `logout/`, the SPA catch-all |
| DRF endpoints under `api/` | 24 | after dropping the router's format-suffix duplicates and `drf_format_suffix` |
| **total registered** | **101** | |

Then the sweep itself: **46 anonymous requests**, GET and POST at each of the 23
non-public DRF endpoints. **All 46 answer 401. There is no defect here.** Recorded
explicitly because a negative is a result, and because the previous state of this
plan was "nobody has looked", which is not the same as "there is nothing".

**The one deliberate exception, and the trap that hides it.**
`djchat/urls.py` builds the schema view with `public=True` and
`permission_classes=(permissions.AllowAny,)`. That is a choice, and a defensible
one for an API schema. What makes it worth writing down is that it is invisible to
the obvious check: **`permission_classes` passed to `as_view()` lands on the
instance, not on the class.** `SchemaView.permission_classes` reads
`IsAuthenticated` while the view actually serving `/api/v1/schema/` is `AllowAny`.
A test that scanned classes would have reported this app's one public endpoint as
protected - wrong in the unsafe direction, and silently so.

What it discloses: the document names all **22** `/api/v1/` paths and the
parameters in them (`user_id`, `friendship_request_id`, `room_id`). **No data** -
structure only. `chat/_tests/test_schema_endpoint.py` already pins that it is
public and describes the app, so this plan does not duplicate it. The judgement
call is yours: close it by removing `permission_classes` from `schema_view`, or
leave it and accept the disclosure. Not decided here.

Measured under reversion R1, with the default permission removed entirely, the
views do **not** leak - they reach unguarded code and answer **405** or **500**
(`AttributeError: 'AnonymousUser' object has no attribute 'rooms'`), except
`/api/v1/users`, which answers **400** until you supply the `?email=` that makes
item 55's oracle disclose anything. So every view here *trusts* the configured
default rather than checking for itself. Not a defect while `IsAuthenticated` is
the default in settings, and it is now pinned by a test, so it becomes one the
moment somebody changes that default without this sweep.

**Three tests**, in `djchat/core/_tests/test_api_auth_surface.py`:

1. `test_every_api_endpoint_rejects_an_anonymous_caller` - the sweep. Sends GET
   and POST rather than "the right method per view", because a view set's
   handlers are bound onto the *instance* by `as_view({'get': 'list'})` and
   cannot be read off the class, and because it does not matter: `dispatch()`
   runs `initial()`, where `check_permissions` lives, **before** it looks up a
   handler at all.
2. `test_the_routes_the_sweep_skips_are_the_django_ones` - the filter's other
   side. The 74 are not 74 unknowns, and this asserts the breakdown
   (`{admin: 59, accounts: 12, api: 2, ^.*$: 1}`) so a new plain Django view
   wired under `/api/` fails here instead of joining the unchecked set in silence.
3. `test_the_schema_is_the_only_public_endpoint` - the review gate on the
   allowlist. Test 1 skips whatever is in it, so a second entry would silently
   stop being checked.

| reversion | result |
|---|---|
| R1 settings `IsAuthenticated` -> `AllowAny` | killed; names all 46 offenders |
| R2 a second entry added to `PUBLIC_API_ROUTES` | killed; prints the added route |
| R3 a plain Django view wired under `/api/` | **simulated, not executed** - see below |

R3 was verified by running the same counting logic over the URLconf with one
synthetic route added: `api` goes 2 -> 3 and the api set gains
`/api/v1/health/`, so both assertions fail. It was not executed as a reversion
because writing the scratch harness was denied by the permission classifier, and
the denial was explicit that the outcome should not be reached another way. The
two executed reversions above were real, run against this exact file, and every
mutated file was restored byte-identical inside a `finally`.

**Three measurement bugs of mine, recorded because each produced a passing lie.**

1. The first probe omitted the leading slash. `str(entry.pattern)` carries none,
   so all 31 URLs 404'd - a clean sweep that had touched no view at all.
2. The finished sweep then **aborted on the first crashing view**, because
   Django's test client re-raises an unhandled exception instead of returning
   500. One endpoint took the whole loop down and the test still ran. Fixed with
   `api_client.raise_request_exception = False`, which is why the message above
   can name all 46 instead of the single `AttributeError` that leaked first.
3. I wrote a third test covering the schema's contents, which
   `chat/_tests/test_schema_endpoint.py` already covers. Deleted mine - two tests
   that restate existing ones is worse than one that does not exist.

pytest **240**, jest **134** unchanged - no frontend source was touched, so the
bundle was not rebuilt.

### 60. The socket's origin check had never been run, and three tests could not tell

Coverage was the guide, as it was in item 42. It still reports
`djchat/djchat/routing.py` at **0%**, and item 42 already recorded why: nothing
imports it. `djchat/asgi.py` builds its own `ProtocolTypeRouter` inline and is
what `deploy.sh:54` serves. Two copies of the same ASGI stack, one of them dead
- and the dead one has no `"http"` branch at all, so anything pointed at it would
serve no HTTP whatsoever. That part is a re-confirmation, not news.

**The new part is what nobody had asked.** Item 15 noticed the validator was
present; item 42 found the duplicate was dead. Neither asked what
`AllowedHostsOriginValidator` actually *does*, because it had never been run
against an `Origin` header. Measured through the real `djchat.asgi.application`:

| case | result |
|---|---|
| member, same-origin | **accepted**, and its group message arrives |
| anonymous socket | **refused** |
| member, cross-origin, `ALLOWED_HOSTS=['*']` (the dev default) | **accepted** |
| member, cross-origin, `ALLOWED_HOSTS=['testserver']` | **refused** |
| member, unrouted path | raises `ValueError` - channels' own default |

So the check works. Two details of channels make it easy to get wrong, and both
cost me a probe bug:

1. **`AllowedHostsOriginValidator` is a factory.** It reads `settings.ALLOWED_HOSTS`
   when it is *called*, and `asgi.py` calls it at import time, so
   `override_settings` cannot reach the application under test - the host list
   was frozen before the test began. Asking the question at all means rebuilding
   the stack.
2. **A wildcard disables it completely.** With `'*'` present even a *missing*
   `Origin` header is admitted: `if parsed_origin is None and "*" not in
   self.allowed_origins`. So the protection is real but dormant on a default
   deployment. **Not a defect** - `deploy.sh:22-26` already makes
   `DJANGO_ALLOWED_HOSTS` a required deploy-time variable and states exactly what
   ships without it. Recorded because it is the one socket property that had no
   test behind it.

**The finding worth the item: three of the four tests would not notice if
somebody deleted `AllowedHostsOriginValidator(` from `asgi.py`.** Not a
hypothetical - it is what the first three tests were written to catch, and they
would have missed it, for two separate reasons. The real application admits a
cross-origin socket under the dev default whether or not the wrapper is there,
so behaviour cannot make the point; and the two behavioural tests build their
own stack, which means they were re-testing **channels** rather than this
project's configuration.

| reversion | result |
|---|---|
| R4 unwrap the validator in `asgi.py` | **not executed** - see below |
| R5 inert re-indent of the same expression | **not executed** |

The harness write was denied by the permission classifier, and the denial was
explicit that the same outcome must not be reached another way, so R4 and R5 are
recorded as unrun rather than worked around. What *was* checked is the
discriminator itself, in memory: the wrapped stack is an `OriginValidator` and
the unwrapped one is a `CookieMiddleware`, so the `isinstance` assertion does
separate them. That is weaker than an executed reversion and is labelled as
such. The second half of the claim - that the three behavioural tests survive
R4 - is argued from the table above rather than demonstrated.

**Four tests**, in `djchat/chat/_tests/test_socket_origin.py`:

1. `test_a_signed_in_browser_receives_its_own_notifications` - the whole chain
   end to end, and a group message actually arriving. `test_socket_path.py`
   proves the browser can *connect*; this proves something is delivered when it
   does, which is a different failure - a socket that connects and never
   delivers looks exactly like a quiet server.
2. `test_a_cross_origin_socket_is_refused_when_the_host_is_named` - both halves
   on purpose. A test asserting only that cross-origin is refused passes just as
   well against a stack with no validator, because an unauthenticated socket is
   refused too; asserting same-origin still connects is what makes the refusal
   mean something.
3. `test_the_real_application_carries_the_origin_validator` - the structural
   pin on the shipped object, and the only one that can catch the deletion.
4. `test_a_wildcard_allowed_host_turns_the_check_off` - the dormant default,
   recorded so relaxing the deploy requirement shows up here.

**Three probe bugs, all mine, each of which first looked like a finding.** I set
`scope['user']` and expected the stack to use it - `AuthMiddleware` overwrites
it from the session cookie, which is exactly why no existing socket test could
reach `routing.py`. Then I built a session inside the async block and hit
`SynchronousOnlyOperation`. And my first attempt at the subset assertion asserted
`allowed_origins == settings.ALLOWED_HOSTS`, which fails for a reason that has
nothing to do with the code under test: Django's test setup appends
`testserver` to `ALLOWED_HOSTS` *after* `djchat.asgi` is imported, so the
validator holds `['*']` and settings reads `['*', 'testserver']`. Subset is the
right claim anyway - the frozen list should invent no host the project does not
also allow.

**Also measured this item, and clean.** Object-level authorization on the HTTP
side is fully pinned already, endpoint by endpoint: export, activity, delete,
mark-read, writing, post-into-room, room list, recents, friendship requests, and
marking someone else's message read each have a non-member test. Every
`group_send` target is derived from `room.participants`, and every HTTP entry
point that triggers one is membership-gated. Item 59's sweep was needed because
*login* auth was under-covered; this axis was not, and re-measuring it changed
nothing.

pytest **240** -> **244**. jest **134** unchanged, no frontend source touched,
bundle not rebuilt.

### 61. The one-line claim at the end of the sweep, tested - and it was true, and it hid a crash

The sweep closed with a claim rather than a finding: "a rename that moved the
client, its spec, the serializer and the test together would leave all of it
green". A claim like that needs running before it is believed, so it got a
harness - rename a wire field on both sides, run both suites, put everything back
byte-identical.

**The first two candidates are dead ends, and why is worth keeping.** `kind` and
`body` are both *model* fields. Renaming either in a `ModelSerializer`'s `fields`
tuple names something the model does not have, and DRF refuses to build the
serializer at all - so the rename goes red immediately, 28 tests, and the red says
nothing about tests at all. A model-backed wire field is loud for a reason that
has nothing to do with the suite: renaming it needs a migration or an explicit
`source=`. Anyone reaching for `kind` to demonstrate this claim gets a false
confirmation.

**The legal seam, and the claim holds on it.** `RoomSerializer.group_profile` is a
`SerializerMethodField` - no column behind it, so DRF serves whatever name the
serializer declares and a rename is a pure text edit. It is read in 14 places
across 6 files: the field and its getter, the Django test, `ContactProfile.vue`,
and three JS specs. Renamed everywhere together: **pytest 244 passed, jest 134
passed.** The claim is true.

The control that makes it a finding rather than a coin flip: rename the
*producer* alone. pytest goes red on `test_private_room_exposes_the_other_participants_profile`
and `test_group_room_profile_exposes_the_group_name` - so the Django half is
genuinely sensitive, and the green above is a coordinated-rename result rather
than blindness.

**The client half is not sensitive at all, and that is where this got
interesting.** The same producer-only rename left jest at 134 passed, because all
three JS specs mention `group_profile` only inside *mock fixtures* - objects they
hand to the store. Nothing there is derived from a response, so no rename of
what the server actually sends can reach them. Rename the consumer alone instead
and jest is still 134 passed - while Vue logs
`Error in render: "TypeError: Cannot read properties of undefined (reading 'group_name')"`.
A component that throws during render, and the suite reports green.

**That error was pre-existing and had nothing to do with the rename.** Chasing it
to its source: `MessagesSection.vue:212` reads
`this.$store.state.rooms[this.selectedRoom].group_name`, `state.js:3,6` starts
the app at `selectedRoom: null, rooms: {}`, and `Rooms.vue:13` mounts
`<messages-section>` unconditionally - the only gate on it is `Home.vue:47`'s
`width >= 768`, which knows nothing about the selection. So `rooms[null]` is
`undefined`, the render throws, and Vue discards the whole subtree. **On any
desktop-width load, before any room is clicked, the message pane renders as a
bare `<div class="relative">`** - no header, no messages, no send form.

The component is not wrong to read through `rooms[selectedRoom]`. Every writer
of the selection guarantees the room is there: `UsersSection.vue:100` selects an
id it just read out of `state.rooms`, `App.vue:52-54` clears the selection before
`REMOVE_ROOM` deletes it, and `ContactProfile.vue:196` records the invariant in
as many words. The unguarded read is a deliberate choice about a state the app
"never enters" - and `null` is the one state it does enter, on every load, which
the invariant never covered.

Fixed with one computed, `currentRoom`, returning `rooms[selectedRoom] || {}`,
used at all three read sites. That is the whole change; no guard at the four
other unguarded `group_name` sites in `User.vue` and `UsersSection.vue`, because
nothing can reach them with a missing room and that would be defensive code for
a state the store cannot produce.

`messages_section_no_selection.spec.js` pins it in two tests: one on the store's
own initial state, one that a selected room still renders its name and avatar -
because the guard that always returns `{}` passes the first and breaks the app.
The second test passed before the fix, which is what makes it a control rather
than a co-conspirator. The reversion is the pre-fix run itself: the first test
red with the named `TypeError` at `MessagesSection.vue:217`, the second green.

`room_paging_race.spec.js` gets a fixture fix too, and it is the reason this was
invisible rather than merely unfixed: it sets `selectedRoom = 8` directly on the
mock store while its `rooms` has only key 7 - bypassing the only two writers -
so **that spec had been throwing on every run and reporting PASS.** Its stated
intent, "the user opens room 8", presumes room 8 exists, so the fixture now has
it. That change is fidelity, not a kill: with `currentRoom` in place the spec
passes either way, and no test depends on it. The kill belongs to the new spec
alone, which is the point - the fixture was never the thing standing between this
bug and a red suite.

**Left open, and it is the real hole.** No Vue error in this suite fails the
test that caused it; Vue logs it and carries on. That is what let a crash sitting
in a spec's output for the life of the file read as 134 passed. The blunt fix -
an `errorHandler` in a `setupFilesAfterEnv` that fails the test - was not taken,
because it would break the specs that *deliberately* drive error paths:
`failed_send`, `invitations_refusal`, `contact_profile_stale_error` and others
log `Error in created hook (Promise/async): "Error: offline"` on purpose. Marking
those as intentional needs a per-spec opt-out, which is a larger design decision
than this item earned. Recorded here instead of fixed, with the measured evidence
above.

pytest **244** unchanged. jest **134** -> **136**, no frontend source left
unpinned. Bundle rebuilt: 5 occurrences of `currentRoom` in
`static/dist/bundle.js`, 0 of the old deref.

### 62. The suite could not fail on a render error, which is how item 61's crash survived

Item 61 closed with a hole recorded rather than fixed, and it was the load-bearing
one: a component that throws while rendering does not fail the test that rendered
it. Vue logs it and carries on. That is why `room_paging_race.spec.js` could throw
the identical `TypeError` on every run for the life of the file and report PASS.

**What already exists, and why it is not enough.** `@vue/test-utils` does fail a
test whose component throws: its handler marks `vm._error` and rethrows, and
`throwIfInstancesThrew` converts that into a failure at the next checkpoint. Its
own source names the limitation - "Vue swallows errors thrown by instances, even
if the global error handler throws". A render error raised by a *re-render* lands
inside `flushSchedulerQueue`, a microtask, where the rethrow has nobody to catch
it. It leaves as an unhandled rejection, jest prints it as console noise between
tests, and no test is attributed. Every checkpoint VTU relies on is before that.

**The obvious fix is a trap, and it was measured before being rejected.** A global
`Vue.config.errorHandler` looks like the right instrument. Reading the source
first: `addGlobalErrorHandler` *refuses to install its own handler when a global
one already exists* - it warns and returns. So claiming that field would silently
switch off the `_error` mechanism above and trade this hole for a larger one. A
probe confirmed the rest of the shape too, and one detail worth keeping: a render
error does reach a global handler, and `info` for it is `"render"` - so the filter
has something exact to key on.

**What is in place.** `tests/unit/setup_render_errors.js`, registered through
`setupFilesAfterEnv` in `package.json`. It wraps `console.error`, notes anything
carrying `Error in render`, and fails the test in `afterEach` - naming the error.
It observes what Vue prints, which reaches `console.error` whether or not VTU
installed its own handler, so it costs no trade at all.

**Scoped to render errors deliberately.** The suite has eight created-hook
failures, all of them in `websocket_reconnect.spec.js`, which injects
`Promise.reject(new Error("offline"))` and asserts the failure *is* handled - the
other six load fetches still issued, a failed unread fetch still fetching
messages, no rejection escaping a push handler. Those are the *expected* outcome
of the tests producing them. A render error is never expected: a render is meant
to produce a subtree, and a throw means it produced nothing. That distinction is
what removes the per-spec opt-out item 61 said it would need, so the deferral is
resolved rather than repeated.

*Corrected after the fact, because the first version of this item named the
wrong files.* It attributed those eight to `failed_send`, `invitations_refusal`
and `contact_profile_stale_error`. Measuring per spec instead of by eye: all
eight are in `websocket_reconnect.spec.js`, and those three files emit none. The
scoping was right and the reason was wrong. The audit that caught it is pinned in
`render_error_gate.spec.js`: the set of specs injecting a deliberate rejection is
asserted to be exactly that one file, so the next author to reject a fetch has to
update the list on purpose - which is the moment to notice the render gate will
not see their errors either.

**Measured, then proved.** Full suite with the gate installed: **136 passed**, no
false positives, the eight deliberate errors untouched. Then the reversion -
item 61's pre-fix condition restored exactly, the `|| {}` guard removed *and*
room 8 dropped from `room_paging_race.spec.js`'s fixture. `a late 'nothing older'
does not cap the chat you switched to` went red:

    a component threw while rendering, so the DOM this test went on to assert
    against was never built - and the test still passed:
      [Vue warn]: Error in render: "TypeError: Cannot read properties of
      undefined (reading 'group_name')"

That test's own assertion is `noMoreMessages` being `false`, and it was still
false. **Its own assertions would have passed; only the gate fails it** - which
is the whole claim, shown rather than asserted. Its sibling, which never leaves
room 7, stayed green, so the gate is not simply failing anything it sees.

`render_error_gate.spec.js` pins the registration, which behaviour cannot: a test
that provokes a render error is a test the gate fails, so there is nowhere to
write `expect(boom).toBe(true)` from inside. Deleting `setupFilesAfterEnv`, or
renaming the marker to a string Vue never prints, both leave a gate that looks
installed and catches nothing - and that is exactly how item 61's crash lived.
Behaviour belongs to the reversion; shape belongs to this file.

Three shape pins, because the gate has three ways to decay into something that
looks installed and catches nothing. The third is the deliberate-rejection set,
audited above: adding the needle to `contact_profile_delete.spec.js` turns it red
and names the file. That first attempt at the reversion **passed**, which was the
harness lying rather than the pin - the `str.replace` matched nothing, the
mutation was never written, and the run proved nothing. Asserting the write landed
is what turned it into a check; the same trap item 52 walked into.

pytest **244** unchanged - nothing server-side was touched. jest **136** -> **139**,
**24** -> **25** suites. No frontend source changed, so the bundle item 61 built
still matches its source (5 occurrences of `currentRoom` in each) and was not
rebuilt.

### 63. The only live component nothing mounts, and three negatives measured on the way

The plan's standing line is that "rendering is only covered where it carries
logic". Asked what that leaves, the answer is a list: of 24 `.vue` files, four are
never mounted by any spec. Three of the four are correctly uncovered - `Example.vue`
is the dead file this plan has already recorded, and `SuccessAlert` and
`InviteFriend` are one prop and a slot with no logic between them.

**The fourth is `WindowSize`, and it carries the logic.** It is registered in
`App.vue`, and every spec touching `App` uses `shallowMount`, which stubs
children out - so its `created()` hook had never run in this suite. What it feeds
is not cosmetic: `Home.vue` gates both panes on it, `v-if="width < 768"` for the
sidebar and `v-if="width >= 768"` for `<rooms>`, so `state.width` decides whether
the chat pane exists at all. Item 61's crash was inside that pane and only
reachable at desktop width, which makes this the switch that put the bug in front
of the user. Untested, it is the one component that can take the whole pane away.

**It is also correct.** No defect, recorded as such: `created()` measures before
the first resize, the store wiring is all present (`SET_CURRENT_WIDTH` at
`mutations.js:159`, `width: null` at `state.js:32`, `<window-size />` at
`App.vue:3`), and the listener is removed on teardown. `state.width` starts as
`null`, so `null >= 768` is false and the first paint is the narrow layout, which
is why the flash is invisible. `window_size.spec.js` pins all four properties
that matter: measured on mount, follows the window on resize in both directions,
removes *the same function* it added, and stops committing once destroyed.
Identity matters there - removing a listener matches on the function, not the
event name, so a typo in `destroyed` or a re-bound method would leave it attached
while an event-name assertion still read as correct.

Three reversions, each killing exactly the tests it names and no others:

| reversion | tests that fail |
|---|---|
| `destroyed` -> `destructed` | the two lifecycle tests; both data tests pass |
| `created()` no longer calls `handleResize()` | the mount test only |
| `created()` never subscribes to `resize` | the two that depend on the subscription |

**Three negatives measured first, so the search is on the record.** The obvious
next candidates, each checked and each closed:

- **A private room's `group_name` is `None`**, `models.py:94` is nullable and
  `get_or_create_private` writes no name - and `User.vue:20` does
  `room.group_name.charAt(0)`. Not reachable: `RoomSerializer.get_group_name`
  answers with the peer's username, private rooms are guarded to exactly two
  participants at `roomViews.py:304` and `:311`, and groups require a non-empty
  name at `:325`. Removing the `.remove(current_user)` from `get_group_name` -
  which would title a private chat with your own name - is caught by
  `test_group_name_reports_the_other_participant_for_private`.
- **A consumer handler that raises does fail its test.** This was the backend
  twin of item 62 and the obvious candidate: replace `chat_message` with one that
  throws and the `RuntimeError` propagates straight out of `receive_from()` into
  the awaiting test. Channels surfaces it; no gate needed.
- **The client sends nothing over the socket.** No `.send(` anywhere in `src/`,
  which is why `ChatConsumer` correctly implements no `receive`.

pytest **244** unchanged. jest **139** -> **143**, **25** -> **26** suites. No
frontend source changed, so the bundle is untouched and still matches its source.

### 64. The switch has one reader, and nothing had ever mounted it

Item 63 ended on a measurement about `WindowSize`. This is the other end of it.

`Home.vue` is what `state.width` exists for, and **no spec had ever mounted it.**
`grep -rln "views/Home" tests/unit/` returned nothing before this item. The one file
that talks about the responsive branch at all, `menu_keyboard.spec.js:12-13`, does so
in a comment. Five specs do set `width: 1200` in their store mocks
(`contact_profile_delete.spec.js:24`, `create_group.spec.js:374`,
`contact_profile_stale_error.spec.js:48`, `room_export_links.spec.js:26`,
`keyboard_reach.spec.js:43`) - but each of them mounts a child component directly, so
`Home` never reads the number and the value is incidental there.

So the gate that decides whether a chat is on screen at all was unpinned. Proved the
blunt way: `v-if="width >= 768"` -> `v-if="width > 768"`, run against the whole suite.
**26 suites, 143 tests, all green** - the desktop pane deleted at the one width where
its presence is a visible decision.

**Why 768, and why that width is the one.** The two branches are `< 768` and `>= 768`,
a partition: every width belongs to exactly one. Flip either operator and the single
width where they stop agreeing is 768, because `768 > 768` is false while `768 < 768`
was already false - so at 768 *neither* renders. Not a blank page, which is what makes
it worth naming: `openMobileRooms` (`Home.vue:48`) guards itself with
`if ("mobile-rooms" in this.$refs && ...)`, so tapping a conversation in the list
silently does nothing, with no error to explain it.

768 is not a number somebody picked. The sibling column one line above the branch is
`<div class="w-full md:w-1/3">`, and `md` is `768px` in `tailwind.config.js` - and in
Tailwind 1.1.4's own `stubs/defaultConfig.stub.js`, measured, so it is 768 from both
directions. At exactly 768 CSS has already given the left column a third of the
screen. If the right-hand pane is absent there, a third of the viewport is dead space on
the most common tablet width, and the layout is split by a number that agrees with
itself by coincidence.

**No defect.** As written the partition is correct, 768 matches `md` from two
independent sources, and the ordering in `App.vue` that feeds it is correct too. This
is coverage, and it is recorded as coverage rather than dressed up as a fix.

`tests/unit/home_pane_split.spec.js`, six tests, `shallowMount` because the assertion is
*which* child is in the tree - every child is stubbed, so no child's `created()` runs
and nothing below the subject is under test.

Six reversions, each killing the test it names:
- `width >= 768` -> `width > 768` kills "at exactly 768 the chat pane is on screen"
- `width < 768` -> `width <= 768` kills "every width gets exactly one layout" - and
  only that one of the first four, since 768 renders the pane either way. That test
  exists for the overlap the boundary test structurally cannot see.
- `width < 768` -> `false` kills "a narrow window gets the drawer"
- `width >= 768` -> `false` kills "a wide window gets the chat pane"
- **the branch frozen at mount** kills "resizing moves the pane" and *nothing else* -
  `created()` reads `state.width` once into `mountedWidth` and both `v-if`s read that.
  Measured, not argued: 4 passed, 1 failed. R1-R4 cannot distinguish this from the real
  component, so without it the fifth test is a copy of the first four.
- **`<window-size />` moved below `<router-view />`** in `App.vue` kills "the pane's
  number exists before the pane's first render" and nothing else: `Received: null`.
  `state.width` starts as `null` (`state.js:32`) and `null >= 768` is false, so a first
  render that ran before `WindowSize` measured anything would put the *phone* layout on
  a desktop. It is right today only because the producer is line 3 of `App.vue` and the
  consumer is line 5, and every other test in the file supplies its own width, so
  nothing else would notice the two swapping. That test is the only thing in the suite
  that mounts `App`, and it stubs `global.WebSocket` because `App.created()` builds a
  real one whose `onclose` reschedules itself through `setTimeout` - left alone, it
  leaves a retry timer running past the end of the test.

**A third harness trap, and the one worth generalising.** The R5 guard was
`assert old not in landed`, carried forward from every reversion before it, and it
**failed on a mutation that had landed**. The replacement *embeds* the anchor - the
inserted `created()` sits directly above `computed: {`, so the needle is still there by
construction. The guard that actually rules out a no-op replace is the `count == 1`
assert before writing; the landed-check should assert the **new** text is present. The
two are not interchangeable, and the second one is the one that lies. (Item 52 walked
into the first version of this trap, item 62 into the second; this is the third, and the
first where the guard was wrong rather than absent.) The `finally` restored the file
regardless, so the source was never left mutated.

pytest **244** unchanged - nothing server-side was touched. jest **143** -> **149**,
**26** -> **27** suites. No frontend source changed, so the bundle is untouched and
still matches its source. Nothing committed.

### 65. The client's one read of a field the server sends, and two negatives

This picks up the thread item 61 opened and item 64 set up next to: the client
half of the wire contract. Measured first, and it is real.

`ContactProfile.vue` reads `group_profile` in exactly one place - line 257,
`this.getRoom.group_profile || {}` - and five computeds hang off it. Four of them
are rendered: the avatar letter, the name, the description, and the avatar's
background colour, which is hashed off the same username. Renaming that one line
to read `group_peek` leaves the suite **27 suites, 149 tests, green**. Every
profile header in the app goes blank and no test notices.

Silent for two reasons, and the first is worth naming because it is a bad thing to
have. The `|| {}` turns a missing field into an empty header rather than a crash;
a `TypeError` here would have been the *good* outcome - loud, immediate, and
pointing straight at the line. And the three specs carrying `group_profile` in
their fixtures all mount this component, so line 257 genuinely executes under
them. They just never assert anything it produced - they were covering delete
failures and stale messages and hit the line on the way past. That is what
corrected the paragraph above: nothing had failed to run, the assertions were
simply absent.

`tests/unit/contact_profile_peer_header.spec.js`, two tests. The fixture is the
whole `users.api.serializers.UserSerializer` payload -
`('id', 'username', 'email', 'tagline')` - not just the two fields the assertions
need, because a fixture missing `id` is a state the store cannot reach, and item
61 had that exact argument made for it.

Four reversions, each killing the test it names:
- the consumer-only rename at `:257` -> **both**, which is the gap closing
- the read gated on `p.id` -> the group test alone. A group's payload is
  `{id: None, ...}` (`serializers.py:81`), so a client that started requiring an
  id renders group headers blank and leaves every private-room test green. This
  is the reversion that proves the second test is not a copy of the first.
- `getUserTagline` -> `""` -> the private test alone
- `getAvatarName` -> `""` -> both

Two negatives measured on the way, recorded because both looked like defects and
neither is one:

- **The `|| {}` branch is unreachable.** `SET_ROOMS` (`mutations.js:26`) is the
  only writer of `rooms` and has exactly one caller - the fetch - and every
  element is a full server payload. So `group_profile` is always present and
  there is no "room with no profile" state to write a test against. The fallback
  is defensive, not load-bearing, and I did not manufacture a state to cover it.
- **`getUsername` and `getUserTagline` guard on the wrong thing.** Both read
  `this.getGroupProfile ? ... : ""`, but `getGroupProfile` is `{}` when the field
  is missing, and `{}` is always truthy - so the fallback never fires and both
  return `undefined` where `""` was meant. `getAvatarName` two lines above guards
  on `.username` and is right. Not filed as a bug: the only consumers are
  `{{ getUsername }}` and `{{ getUserTagline }}` in the template, Vue 2 renders
  `undefined` as an empty string, and the path is unreachable anyway - so there is
  no user-visible difference to charge a user with. A one-character fix
  (`getGroupProfile.username`) if someone wants the consistency; not a defect.

pytest **244** unchanged. jest **149** -> **151**, **27** -> **28** suites. No
frontend source changed, so the bundle is untouched. Nothing committed.

### 66. The read receipts: the last user-visible feature nothing asserted

The same method as item 65, generalised. `MessageSerializer` sends three
`SerializerMethodField`s - `is_owner`, `all_received`, `all_read`
(`serializers.py:17-34`). `is_owner` is covered. The other two are read in three
production files and asserted by nothing:

    grep -rl "\ball_received\b" tests/unit/    ->    nothing

and `SentMessage.vue`, which draws the ticks, was not mounted by any spec in the
suite. Renaming either field at either of the two sites leaves the whole suite
**28 suites, 151 tests, green** - measured four ways, `all_received` and `all_read`
crossed with `SentMessage.vue` and `User.vue`. The visible effect is the same in all
four: the double tick never appears, every message reads as delivered-never-confirmed,
and nothing notices.

**The logic is written down twice.** `SentMessage.vue:14-45` and `User.vue:40-75` are
near-verbatim copies - three icons, three conditions, differing only in `message` vs
`lastMessage` and a margin class. A spec covering one leaves the other free to drift.
So this has two cases per behaviour, six behaviours, and the reversions below
deliberately target one site at a time.

`read_receipts.spec.js`, **12 tests**, both sites:

- in flight (`sending: true`) -> only `access_time`. The single tick is gated on
  `!message.sending`, so a message on the wire shows a clock and *no* tick.
- delivered -> `done`; `all_received` -> `done_all`; only `all_read` adds
  `text-teal-400` (asserted both ways: merely-received is *not* teal).
- a push overrides what the message said. This is the live path, not decoration:
  the fetched message carries whatever was true then, and `MARK_MESSAGE_ALL_RECEIVED`
  / `MARK_MESSAGE_ALL_READ` (`mutations.js:137-141`, both `Vue.set`, so reactive) write
  the override keyed by message id when the push lands. The render prefers the store
  to the field; without that precedence a receipt could only change at the next fetch.
- being read cannot outrun being received: `allRead: {7: true}` with
  `all_received: false` still renders `done`, because the teal class rides on the
  double tick. Both halves are the server's - `all_read` implies every `pending_read`
  is gone, which implies every `pending_reception` is too.

**The wire half, in `websocket_reconnect.spec.js`, 3 tests.** `App.vue:64-71` is the
only consumer of `update_message` anywhere in the client, and `chat/models.py:73-86` the
only producer. The four messages that spec pushed were exactly the ones that `dispatch`
a fetch - `update`, `update_rooms`, `update_received`, `update_sent` - so this branch
had never run under test. Added: both `kind` strings commit their mutation with the
**message id** (not the payload - both mutations are keyed by id, so committing the
payload keys the store off an object and the lookup in `SentMessage.vue` never hits),
plus an unrecognised `kind` commits nothing. `pushApp`'s store mock gained
`commit: jest.fn()`; no existing test reads it.

**Eleven reversions, each killing only what it names.** R1 SentMessage `all_received`
killed only the two chat-side rows, the room-list rows passing; R2 User
`all_received` the exact reverse; R3/R4 the same pair for `all_read`; R5/R7 the
store-precedence one at each site independently; R6/R8 the `!sending` guard
independently; R9 the `kind` literal; R10 the id-versus-payload; R11 turning the
`if`/`else if` chain into an `if`/`else` killed only the unknown-kind row with both
known-kind rows surviving. The pairing is the evidence: no assertion here is
redundant, and no single-site mutation is masked by its twin.

**Two negatives, and one asymmetry not changed.**

- The item-62 render gate earned its place twice, both times on my fixture rather
  than the product. `room: { id: 7 }` crashed `getHash` (`variables.js:9`) via
  `User.vue:152`; adding `group_name` then crashed `dateFormat` at `:162` with
  `TypeError: Invalid date`. `grep -o "room\.[a-z_]*"` enumerates exactly three fields
  the component reads, and the fixture now carries all three. That is item 61's trap -
  a fixture describing a state the store cannot reach - applied to a different
  component.
- `room.group_name` cannot be missing. `roomViews.py:325` refuses a nameless group and
  a private room's is the peer's username (`get_group_name`). So `User.vue:141`'s
  unguarded `getHash(this.room.group_name)`, where `ContactProfile.vue:271` has
  `|| ""`, is a latent asymmetry that is currently unreachable. Recorded, not changed:
  there is no state to reproduce it from.
- The receipts are **correct end to end**. `models.py:75,85` send exactly the `kind`
  strings `App.vue:66,68` handles; both mutations are correctly `Vue.set`. No
  production file changed and **no defect was found** - what closed here is the test
  gap, not a bug.

pytest **244** unchanged. jest **151** -> **166**, **28** -> **29** suites. No frontend
source changed, so the bundle is untouched and still matches its source. Nothing
committed.

### 67. The sidebar row's initial, and how the name came to be covered by accident

Same method as items 65 and 66, one field over. `RoomSerializer` sends two fields for
a room's identity - `group_name` and `group_profile` - and the client reads both, in
different components. Item 65 pinned `group_profile` for `ContactProfile`. The row,
`User.vue`, never adopted it: it is the one place still on the *older* field.
`getColor` (:141) and both template lines read `group_name` directly.

The field-level rename dies - **18 tests, 3 suites** - so unlike `group_profile` the
consumer side was not wholly unpinned. But that turns out to be the wrong question,
and asking it precisely is the item. The same read renders **two** things:

    :20   {{ room.group_name.charAt(0).toUpperCase() }}   the avatar initial
    :24   {{ room.group_name }}                           the label

and they are not equally covered.

**The initial was asserted by nothing.** Replacing it with
`String(room.id).charAt(0).toUpperCase()` - still truthy, so nothing throws - leaves
the suite **29 suites, 166 tests, green**. The sidebar renders a room's *id* where its
initial belongs, in every chat, and no test notices. Dropping `.toUpperCase()` is
equally invisible, so the *derivation* was unpinned as well as the field.

**The label was covered, but only sideways, and that is the finding worth keeping.**
One assertion in the whole suite catches it: `keyboard_reach.spec.js:112`,
`expect(row.text()).toContain("Bob")`. That assertion is about an accessibility
label. It pins the name only because it asks whether the row's whole text mentions the
room - `row.text()` covers the initial too, so a broken initial hides inside a passing
substring check. Coverage that arrives sideways is coverage that leaves when the test
carrying it is rewritten for its own reasons. Neither spec that mounts `User.vue`
asserts anything it renders: `user_writing_listener.spec.js` asserts only `whosWriting`
and the `EventBus` calls, and `read_receipts.spec.js` only the receipt icons.

`sidebar_row_identity.spec.js`, **4 tests**, asserting rendered text for the reason
`contact_profile_delete.spec.js` gave - an error set in a field while the row showed
something else is not reported, so "on screen" has to be the claim:

- the initial is the first character, uppercased. The fixture is **lowercase on
  purpose** - `toUpperCase()` is half the logic and was unpinned.
- the initial and the label come from the same name, checked on two rooms with
  different names *and* different ids, so neither field alone satisfies it.
- an initial that is not a letter is shown as-is: `charAt(0)`, not "the first
  *alphabetic* character". A future "make the avatar nicer" change that skips to the
  first letter would silently turn "3 blind mice" into "b".
- a group room's name renders the same way, which matters because the obvious fix for
  "a name that looks like a username" is to read `group_profile` here instead, and
  that would render every group room blank.

**Four reversions, and the pairing is what makes them evidence rather than a list.**
R12 is the exact mutation above - it was green before this file and now kills all four.
R13 drops `.toUpperCase()` and kills **exactly one**: the lowercase-fixture test. The
other three use already-capitalised names, which is the only reason that fixture is
lowercase. R14 moves `charAt(0)` to `charAt(1)` and kills all four. R15 swaps the
label to `room.id` and kills three while leaving the initial test standing - so neither
output is standing in for the other.

**No defect, and one negative.** `getColor` is deliberately not asserted, for item
65's reason: it is a pure function of the same single read as the name, so pinning the
name pins the read, and a fourth assertion would pin one seam twice. A bug inside the
hash survives here exactly as it survives there. And the row's unguarded
`getHash(this.room.group_name)` - `User.vue:141`, with no `|| ""` where
`ContactProfile.vue:271` has one - remains unreachable and unrecorded-as-fixed, because
`group_name` cannot be empty (`roomViews.py:325` refuses a nameless group, and a
private room's is the peer's username). Same negative as item 66; it is an asymmetry,
not a bug.

pytest **244** unchanged. jest **166** -> **170**, **29** -> **30** suites. No frontend
source changed, so the bundle is untouched. Nothing committed. Not run over: prettier
reports `unread_axis.spec.js` and `window_size.spec.js` as unformatted - both
pre-existing, both cosmetic line-wrapping plus a missing final newline, neither touched
here, and PLAN.md's own note under "The build" is that a formatting sweep in place
buries the real hunks.

### 68. The sidebar row's preview: a truncation that had never run

Still the row, still the same method, and this one is the clearest result of the
three. `User.vue:77` renders the room's last message through `truncateString`, and
`:32`/`:38` decide whether that preview or a typing indicator occupies the slot. Four
mutations, **30 suites, 170 tests, green, four times over**:

    :77   truncateString(lastMessage.body, 35)  ->  lastMessage.body
    :77   ... 35  ->  ... 10
    :114  return str.slice(0, num) + "..."      ->  return str.slice(0, num)
    :32   v-if="whosWriting"                    ->  v-if="false"

The row could show a 400-character wall of text where a one-line preview belongs, or a
tenth of every message, with nothing to say it had been cut, or a peer typing
invisibly *underneath* the message they were replying to. None of it visible anywhere.

**Why it had never been covered, which is the part worth remembering.** Every
`User.vue` fixture in the suite carries `body: "hi"` -
`read_receipts.spec.js:60`, `keyboard_reach.spec.js:25`,
`user_writing_listener.spec.js:36`. Two characters against a 35-character cap, so the
truncation branch had **never executed once** in any test in the project. And
`truncateString` appears in `User.vue` and nowhere else in `src/` or `tests/` - no
other component truncates, so there was no sibling test standing in for it either. A
branch can be uncovered not because nobody tested the component but because every
fixture happened to be too short to reach it.

**What is already covered, and deliberately not re-tested.** Which message the preview
shows depends on the store holding each room's messages oldest-first, because
`lastMessage` (:159) takes `roomMessages[length - 1]`. `room_message_order.spec.js`
pins that order by `front_key`, and properly - its bug was two endpoints appending in
opposite directions, so the newest landed *first*. This item is only about what happens
to a body once chosen, so the order is a cross-reference, not a second assertion. What
*was* missing is that the row reads the **last** element, and that is one test here.

`sidebar_row_preview.spec.js`, **5 tests**, asserting rendered text:

- a message that fits is shown in full, uncut and with no ellipsis.
- a message of **exactly** 35 is not cut. `truncateString` compares `str.length <= num`,
  and testing only the over case leaves `<` and `<=` indistinguishable - the off-by-one
  that turns a 35-character message into 35 characters plus three dots saying it was
  longer than it was.
- one character over is cut at 35 and marked.
- the preview is the room's **newest** message.
- a peer who is typing takes the slot, and it comes back when they stop - `:32` is the
  `v-if` and `:38` the `v-else`, so this is precedence, not both-at-once.

**Six reversions, each killing a distinct target.** N1 (never truncate), N2 (35 to 10)
and N3 (no ellipsis) were the three green mutations; N4 was the fourth. Each kills only
the boundary test that was written for it, except N2, which kills four because a 10-char
cap truncates every fixture but the 2-character one - which is itself the proof that
the cap is pinned and not merely the presence of truncation. N5 turns `<=` into `<` and
kills *only* the exactly-at-the-cap test. N6 takes `roomMessages[0]` instead of the last
element and kills *only* the newest-message test. N5 and N6 each killing exactly one, and
different ones, is what shows neither is standing in for the other.

**One measurement note, and it is mine.** The first run of this file asserted against
`.body-section` and all five tests failed with `"done"` - the read-receipt material-icon
text from item 66's fixture, which shares this component. `.body-section` holds the
preview *and*, for a message you sent, the receipt icons. The fix was to scope to
`p:not(.circle)`, which excludes the unread badge by class rather than by relying on
`unreadMessages` being empty. Recorded because the container that holds the thing you
want is not the thing you want.

**No defect.** The truncation is correct at its boundary, the ordering is correct and
already pinned elsewhere, the precedence is correct. What closed here is the test gap.
One note for a future change rather than a fix: the `35` is an inline literal in the
template, not a named constant, so this spec hardcodes it. `send_form_maxlength.spec.js`
binds to its component's constant *because there is one*; if this ever moves to a
`maxLength` in `data()`, that binding becomes available and should replace the literal.

pytest **244** unchanged. jest **170** -> **175**, **30** -> **31** suites. No frontend
source changed, so the bundle is untouched. Nothing committed.

### 69. Coverage run instead of a guess, and the item-54 claim that was half true

The last four items were chosen by following a thread field by field. This one was
chosen by measurement instead, because that is the method the file itself says to
trust. A coverage run over `src/` puts **every** file at 100% except two:

    src/store/actions.js     7.41% stmts   0% branch
    src/store/mutations.js  65% stmts  61.54% branch

So the remaining frontend gap is not scattered, it is the store. `actions.js` is 281
lines of axios wrappers - and it contains exactly **two conditionals**. Both were
unmeasured, and so was one `commit` beside them. Three mutations, **31 suites, 175
tests, green**, three times over:

    A1  fetchPastMessages always appends `?offset=`       (ternary dropped)
    A2  sendMessage never sends `front_key`              (spread deleted)
    A3  sendMessage never commits REMOVE_FAILED_MESSAGE

**A1 selects a server query, not just a URL.** `LastMessagesRoomAPIView` reads `offset`
and branches on it (`messageViews.py:74-85`): with one it pages `id__lt=offset`,
without one it takes the newest ten. Dropping the client's ternary therefore sends
`?offset=undefined` into the branch that answers `ParseError('offset must be a message
id.')` - a 400 in the one situation that is supposed to work. The two branches are two
different queries, and only one of them was named by anything.

**A2 corrects this plan.** Item 54 is recorded as pinning "`sendMessage`'s three keys",
and it does - **on the server**: `test_the_created_message_carries_the_clients_front_key`
POSTs a `front_key` and asserts the serializer keeps it. That pins the field's
acceptance, not the client's sending of it, so deleting the client's spread left the
suite green. The two halves never check each other, which is items 61 through 68's
subject again - on a key rather than a field. The item is not wrong about what it did;
it was read as wider than it was.

**A3 is the same shape one line over.** `failed_send.spec.js` pins the
`REMOVE_FAILED_MESSAGE` *mutation* - a refused message comes off its clock and your text
comes back. Nothing pinned the action *calling* it, and the comment at
`actions.js:85-88` says that catch is "the only place that knows": `sending` is cleared
only when the server's copy comes back, which after a failure it never will. Delete the
commit and a refused message keeps its clock forever, with the recovery logic sitting
green one layer below the test that verifies the recovery logic works.

`action_requests.spec.js`, **7 tests**, using the `jest.mock("@/backend")` shape
`email_lookup_encoding.spec.js` already established - no new infrastructure:

- paging names the message to go back from; asking for the newest names **no offset at
  all**, compared with `toBe` on the whole URL because the failing form
  (`?offset=undefined`) contains nothing wrong-looking.
- a send with a key carries exactly `room`, `body`, `front_key`; a send without one
  omits the key entirely. `Object.keys(...).sort()`, not `toEqual` - `toEqual` ignores
  `undefined`-valued properties, so a `front_key: undefined` payload would score equal
  to one with no key, which is the exact distinction the conditional spread makes.
- a refused send commits `REMOVE_FAILED_MESSAGE` with `front_key` **and** `room` - the
  key is only unique within a room, so one without the other restores the wrong message
  when two rooms fail at once - and it *rejects* rather than resolving.
- a send that succeeds commits **nothing**, which is what keeps the two above honest:
  the bubble keeps `sending: true` until the socket replaces it.

**Seven reversions, six killing exactly one test.** A3 and A5 both target the clock test
(the commit removed, and the commit stripped of its `room` half); A6 kills two, because
the clock test awaits a rejection too and that is correct rather than redundant. A1, A2,
A4, A6 and A7 each kill a different single test, which is the non-redundancy evidence.

**The item-62 render gate fired, and the honest fix was the gate.** It scans the spec
directory for the literal `Promise.reject(new Error("offline"))` and asserts an exact
closed list, so the new spec failed the run. Two escapes were available and both are
wrong. Renaming the error string would dodge the needle without answering it. Adding
the spec to the list would be truer to the needle and false about the risk: the gate
blinds itself to *Vue* errors, and `action_requests.spec.js` has no component in the
tree, so it has no render to miss. So the list is now both entries with the reason for
each written down, and `readdirSync` results are sorted - a closed set that reorders
itself with the filesystem is a flaky assertion. `jest@24.9` has no
`mockRejectedValueOnce`, so `mockImplementationOnce(() => Promise.reject(...))` is the
only spelling available and the needle was never going to be avoidable by tidiness. The
gate got *stricter*, not weaker: it still asserts an exact set, so the next spec that
rejects a fetch still has to declare itself.

**No defect.** Both conditionals are correct as written, and the three-key correction
is to this file, not to the code. `actions.js` branch coverage **0% -> 100%**; its
statement coverage is 18.52% because twenty-one straight-line axios wrappers remain
unexecuted, and I am not proposing those - they are `get(url).then(commit).catch(reject)`
with no branch in them, and item 68's lesson says the risk is in what a fixture can
reach, not in line counts. `mutations.js` at 65% is the same shape and the same answer.

pytest **244** unchanged. jest **175** -> **182**, **31** -> **32** suites. No frontend
source changed, so the bundle is untouched. Nothing committed.

### 70. The middle of item 66, which turned out never to have run

Item 69 closed with `mutations.js` measured and declined as "the same shape and
the same answer" - a reason asserted rather than measured, which is the thing item
69 itself exists to distrust. So: measured.

Every file in `src/` is at 100% except `actions.js` and `mutations.js`. Of the
uncovered lines in `mutations.js`, `137-142` are `MARK_MESSAGE_ALL_RECEIVED` and
`MARK_MESSAGE_ALL_READ` - **item 66's own two mutations.**

Item 66 pinned the receipts twice over, and the two halves do not touch.
`websocket_reconnect.spec.js` asserts App.vue commits the mutation on the push;
`read_receipts.spec.js` asserts the store override beats the message's own field
in the render. But `websocket_reconnect.spec.js` **mocks the store**, and
`read_receipts.spec.js` hands the component a plain object with the key already in
it. So neither spec ever executed the middle of the chain:

    App.vue:66           commit("MARK_MESSAGE_ALL_RECEIVED", message_id)
    mutations.js:138     Vue.set(state.allReceived, message_id, true)
    SentMessage.vue:23   allReceived[this.message.id] || message.all_received

Measured, not assumed. **32 suites, 182 tests, green**, four times over:

    Vue.set(state.allReceived, message_id, true)  ->  state.allReceived[message_id] = true
    Vue.set(state.allRead,     message_id, true)  ->  state.allRead[message_id]     = true

In Vue 2, adding a key to an observed object without `Vue.set` is not a reactive
change - there is no dependency to notify, because nothing had read that key
before it existed. The substitution produces a store that *holds* the right value
and a screen that never updates: every receipt correct in the store, wrong on the
display, permanently, with nothing logged anywhere. Item 66's header says "both
`Vue.set`, so reactive". That was a sentence in a comment, and it is what this
item turns into a fact.

`receipt_reactivity.spec.js`, **2 tests**, running the real mutation against a
`Vue.observable` state and asserting the **screen** changes - never that `Vue.set`
was called, since a refactor to `this.$set` or to replacing the map wholesale
would keep the screen correct and a call-watching test would go red for no reason.

**Three reversions, and the pairing is the proof.** C1 (`allReceived` to a plain
assignment) kills the first test and leaves the second green; C2 (`allRead` to a
plain assignment) kills the second and leaves the first green. Each mutation is
independently load-bearing and neither test stands in for the other - which is
only true because the second test starts from `all_received: true` in the prop
instead of running the first mutation, so it cannot pass on the first one's
reactivity. C3, recording `false` instead of `true`, kills the first.

**Why the third mutation in `mutations.js` is safe, and the first two are not.**
`ADD_UNREAD_MESSAGES` also uses `Vue.set` - per key - and a plain assignment there
is *also* green. It is safe for a different reason, and the difference is worth
stating because it is the whole lesson. `state.unreadMessages` is a **declared**
property (`state.js:15`), so `state.unreadMessages = {}` replaces a property a
computed has already read, and replacing it *is* reactive. The whole `forEach`
runs synchronously before any re-render, so the computed re-reads an already
populated object and the key-level `Vue.set` is belt and braces. `allReceived` and
`allRead` (`state.js:18,19`) are also declared - but the mutations add *keys to*
them rather than replacing them, which is the case Vue 2 cannot track. Declared
property: replaced, so reactive. Key inside one: added, so not, unless `Vue.set`.

**Two more measured, both declined.** B3 above. And B4 - dropping the
`message_id in state.unreadMessages` guard from `REMOVE_MESSAGE_FROM_UNREAD` - is
green, because `Vue.delete` on a missing key deletes nothing and merely notifies a
dependency: a redundant re-render, no wrong value, nothing user-visible. Neither is
proposed, and both are recorded rather than left as a guess. `mutations.js` is
68.33% statements and that number is honest: what is left is
`SET_ROOMS`/`SET_USERS` and twenty-odd straight-line `Vue.set` calls in mutations
whose *reactivity* is the property that matters, and of those the ones anything
reads have now been through the same treatment.

pytest **244** unchanged. jest **182** -> **184**, **32** -> **33** suites. No frontend
source changed, so the bundle is untouched. Nothing committed.

### 71. The third link in the `front_key` chain, and the only in-place mutation in `src/`

Item 70 recorded a negative. This one is a defect, and it is the same shape one
branch over - which is how it was found: the branch next door to the one item 70
had just proved nobody had ever executed.

The `front_key` chain has three links and two of them were pinned by different
items that never checked each other:

    SendForm.vue:66   let front_key = uuid4()
    actions.js:76     ...(front_key ? { front_key } : {})        item 69
    POST /messages/   the serializer keeps the field             item 54
    models.py:60      signal_to_room, to *all* participants
    mutations.js:42   if (state.sendingPool.has(front_key))
    SentMessage.vue:16 v-if="message.sending"

Item 69 pinned the key leaving the browser, item 54 pinned the server keeping
it. Nothing pinned what the third link is *for*. `models.py:60` iterates
`room.participants.all()`, which contains the sender, so the socket does deliver
the sender's own copy - that branch runs on every message, every time - and the
branch did this:

    let message = state.sendingPool.get(front_key);
    state.sendingPool.delete(front_key);
    delete message.sending;
    Object.assign(message, element);

Both lines write the right values and notify nobody. `delete` on an observed
object calls `ob.dep.notify()`, and a watcher that read `message.sending`
subscribed to *that key's* dep, not the object's. `Object.assign` is not a
reactive operation at all, and it adds `id`, `all_received` and `all_read` as
keys that did not exist. Measured, with the store asserted *before* the screen
so the failure could not be "the branch never ran": the sendingPool empties, the
id lands, the message count is right, and the row still shows `access_time`.

**Severity, measured rather than guessed.** I did not know whether the clock
never cleared or cleared late, and the difference matters. Under the old code,
after the server confirmed: `access_time`. After the *recipient's* client
acknowledged delivery - which is item 70's properly reactive
`MARK_MESSAGE_ALL_RECEIVED`, pushed from `remove_user_from_pending` when the
last participant acks: `done_all`. So the clock cleared only when the other
person's device received the message, and never at all if they were offline.
Your own message sat on a "sending" clock after the server had already stored
it, and then jumped straight from the clock to two ticks, never passing through
the sent-but-unacknowledged state the icon set was built for. Under the fix it
shows `done` at confirmation and `done_all` at the receipt.

**The obvious test passes against the broken code, and why.** Mounting
`SentMessage` on its own, mutating the object and asserting the icon cannot see
this, whichever of the two spellings is used: `shouldUpdateComponent` compares
props by identity, so a parent re-render carrying the same object skips the
child, and the child's own dep was never the one notified. Only a *different*
object arriving as a prop reaches it, which is `MessagesSection.vue:89`'s v-for
re-running. So `send_confirmation.spec.js` mounts `MessagesSection`. I wrote the
`SentMessage` version first, watched it fail, and kept the failure as the reason
the file is shaped the way it is.

**The fix reuses what the file already had.** The server's copy *replaces* the
optimistic one, through `Vue.set` and the `mergeMessages` five lines above -
which already dedupes on `front_key` with the incoming copy winning. No new
helper, no new rule. Scope checked before writing: `LINK_MESSAGES_TO_ROOM` has
exactly two committers (`actions.js:7`, `SendForm.vue:75`), and these two lines
were the **only** in-place `Object.assign` or bare `delete` anywhere in `src/`,
so this is a contained fix rather than the first of a sweep.

**Three reversions, paired.** R1 (the original in-place code) kills *only*
"the server's copy takes the message off its clock". R2 (replacing the room with
the server's copy alone, dropping the history) kills *only* "the confirmed
message replaces its optimistic twin". Neither test stands in for the other, and
the second only became isolable because the fixture carries an `earlier()`
message - with a room holding nothing but the message being confirmed, R2 would
have emptied the chat and passed both tests. R3 (dropping the
`receivedMessages` pruning) kills nothing *here*, which is the point: it kills
`room_message_order.spec.js`'s "a message you sent does not leave a 'seen' key
behind forever", so this file does not duplicate that coverage.

Two harness notes, both mine. The first reversion driver reported all three
reversions as killing nothing, because it tried to scrape jest's per-test
pass/fail tree out of the console text, and jest prints a bullet marker per
failure rather than that tree unless asked; `--json` is the unambiguous channel
and the results above are from it. And R2 initially killed *both* tests, not
one - not because the tests overlap but because test 2 indexed
`roomMessages[7][1]` and so died with a `TypeError` under any change to the
room's length. It now looks the message up by `front_key`, which states the
same thing without making the two failures indistinguishable. Separately, the
`earlier()` fixture needed `state.users` to contain its author:
`ReceivedMessage.vue:47-51` resolves `message.author` as a user *id* against the
store, and an unresolvable author makes `getColor` throw on an unguarded
dereference, which renders as an empty subtree rather than a failing test.

**The bundle.** Frontend source changed, so it was rebuilt. `Object.assign`
drops from 3 occurrences to 2 in `static/dist/bundle.js`, and both survivors are
babel/core-js polyfills rather than app code. The CSS also moved relative to
`HEAD`, so I did not assume it was mine: a control build from the reverted source
produced a byte-identical `bundle.css` (md5 `9e62f981...` either way), which
settles it. That CSS delta is pre-existing drift in the committed artifact, not
this item, and `onclose=function(){}` is still 0.

pytest **244** unchanged - no backend file was touched. jest **184** -> **187**,
**33** -> **34** suites. Nothing committed.

### 72. Two messages in flight, and the ordering it turns out to be

Item 71 fixed what happens to an optimistic bubble when it is confirmed. It only
ever had one in flight, so the next question was two at once - which you get by
typing faster than the server answers. `MessagesSection.vue:89` keys that v-for
on `:key="message.id"`, and an optimistic message has no `id` at all; that is
the entire reason `front_key` exists. So while two sends are outstanding their
keys are both `undefined`, and confirming one changes the key list from
`[1, undefined, undefined]` to `[1, 42, undefined]` - `updateChildren`
reconciling two nodes that claim the same key is a case Vue documents as
undefined.

**Measured: it is not undefined here. Nothing is duplicated and nothing is
dropped.** Mount tolerates the duplicate keys, and by the time the patch runs
only one node is left without an id. That is a negative, and it is recorded
rather than quietly dropped, because the failure I expected and the one that
exists are not the same and the test is worth more for saying which.

**What is real is the ordering, and it is not the order you typed.** Typing
"hi" then "again" and having both in flight renders:

    ["Bob ~bob@example.com earlier 09:00", "again 10:00   done", "hi 10:00 access_time"]

"again" was typed second and is on screen first. `position()` at
`mutations.js:15` gives a message with no id `Infinity`, so *anything confirmed
sorts above anything still in flight*, and two POSTs are free to land out of
order. The window is the gap between the first and second confirmations.

**And it closes.** Measured, not assumed: ids are assigned in POST order, so the
straggler takes its proper place when it lands, and the thread reads correctly
again - `[1, 42, 43]`, "hi" above "again". Both facts are pinned, because
without the second one the first reads as a permanent bug and it is not.

**Not fixed, deliberately.** The comment at `mutations.js:10-14` says the
current ordering is the design: `id` sorts because it is monotonic and is what
the backend paginates on, and unconfirmed messages "keep the order they were
typed in, at the end". The scramble is a consequence of that, not an oversight
in it. Every lazy fix I can see costs more than the behaviour is worth: a stable
insert sequence means a counter in `state` that survives page loads, and sorting
by timestamp mixes the client's clock with the server's, which is worse than the
problem. Both are design decisions about what "order" means for a message that
does not have an id yet, so this is written down for that decision instead of
patched around.

Three tests, all pinning measured behaviour rather than the failure I went
looking for. **Nothing in `src/` changed**, so the committed bundle is untouched
- `bundle.js` md5 is `a7156610...`, byte-identical to item 71's build.

pytest **244** unchanged. jest **187** -> **190**, **34** suites unchanged.
Nothing committed.

### 73. Item 71's fix was the cause of item 72's scramble, not its cure

Item 72 ended with a question rather than a fix, and the question was wrong -
or rather, both of the answers it offered were worse than the problem. Measuring
the reorder against the *original* pre-item-71 code settled it:

    item 72, item 71's fix in place    ->  [1, 42, undefined]
    item 72, original code             ->  [1, undefined, 42]

The original never re-sorted, so it never had the scramble. **Item 71's
`mergeMessages` introduced it**, as a side effect of making the confirmation
reactive by sorting. So neither of item 72's two suggestions - a stable insert
counter in `state`, or sorting by timestamp - was the right shape at all. The
problem was never "what is the order"; it was that a confirmation should not
reorder anything, because the optimistic message is *already in the right slot*,
typed-order at the end, exactly where the user put it.

So the confirmation now replaces the object at its current index and touches
nothing else:

    const inRoom = state.roomMessages[element.room] || [];
    const at = inRoom.findIndex(one => one.front_key === front_key);
    Vue.set(
      state.roomMessages,
      element.room,
      at === -1
        ? mergeMessages(inRoom, [element])
        : [...inRoom.slice(0, at), element, ...inRoom.slice(at + 1)]
    );

Still reactive, because `Vue.set` on an existing key notifies `roomMessages`'s
own dep, which the `messages` computed reads - and still a *different* object
arriving as a prop, which is the only thing that reaches `SentMessage` at all.
The `at === -1` arm is defensive: nothing in the store removes a bubble between
the send and the confirmation today, but splicing a `findIndex` of -1 would
duplicate the last message silently, so the fallback goes through `mergeMessages`
instead.

**The reversion that decides it.** S1 reverts to item 71's exact shipped code
and kills *only* "confirming one of two in flight keeps the order they were
typed" - every item 71 reactivity test survives it. That is the whole finding
in one line: item 71 was sufficient for its own tests and wrong about ordering,
and nothing in item 71 could see it. S2 (the pre-item-71 in-place mutation)
kills the two ordering tests *and* "the server's copy takes the message off its
clock", which is the honest shape of the old code - right about order by
accident, wrong about reactivity. S3 (replacing the room with the server's copy
alone) kills the ordering tests and "replaces its optimistic twin, not the room's
history".

The two duplicate-`undefined`-keys negatives from item 72 survive unchanged and
are still measured rather than assumed: mount tolerates them, and by patch time
only one node lacks an id. So `:key="message.id"` is left alone.

The bundle was rebuilt. `Object.assign` stays at 2 - both babel/core-js
polyfills, no app code - `front_key` is 14, `onclose=function(){}` is 0, and
`bundle.css` is byte-identical to item 71's (`9e62f981...`), which is what
item 71's control build established: a store change cannot move styles.

pytest **244** unchanged - no backend file was touched. jest **190** unchanged,
**34** suites. Nothing committed.

### 74. The load path, which item 69 declined by counting lines

Item 69 closed by measuring `actions.js` at **18.52% statements, 100% branch** -
both figures re-measured and identical here - and declining the rest as "twenty-one
straight-line axios wrappers ... no branch in them", citing item 68's lesson that
risk lives in what a fixture can reach rather than in line counts. That reason was
*asserted*, which is the thing item 69 exists to distrust, so item 70 measured
`mutations.js` the same way. This measures item 69's own excuse.

**What is actually unrun, named.** 22 actions in `actions.js`. Two of them have a
single uncovered line each, and in both cases that line is the trailing
`.catch(error => reject(error))` - `fetchPastMessages` and `getUserIdFromEmail`,
otherwise fully covered. The remaining **18 have never been invoked by any test in
the suite**: `syncDB`, `fetchRooms`, `fetchRecentActivity`, `fetchMessages`,
`markMessageAsRead`, `fetchUnreadMessages`, `postWriting`, `markRoomAsRead`,
`fetchSentInvitations`, `addFriend`, `cancelFriendRequest`,
`fetchReceivedInvitations`, `rejectFriendRequest`, `acceptFriendRequest`,
`deleteRoom`, `fetchUserProfile`, `patchUserProfile`, `fetchRoomActivity`. So
"twenty-one wrappers" is off by three in one direction and it lumps together two
different shapes: wrappers that have run, and wrappers that have not.

*(Two measurement notes, both mine. The first pass reported 20 "never-entered
actions" and mapped each uncovered line back to the nearest preceding `  name(`;
that regex mis-assigned, and a second bug in the same script unpacked
`(name, end_line)` as `(name, line)`, which silently emptied both result lists
before I noticed the file had stopped classifying anything at all. The numbers
above come from a third version that uses each action's real line range. Reading
`coverage-final.json`'s `s` as a map instead of an int count was the third of
these.)*

**One of the 18 is not a wrapper, and it is the one that matters.** `syncDB`
(`actions.js:4-8`) is the only thing in the app that commits `SET_ROOMS`,
`SET_USERS` and `LINK_MESSAGES_TO_ROOM` together, and it has **three** callers -
`fetchRooms:14`, `fetchRecentActivity:29`, `fetchMessages:44`. All three are
dispatched from `App.vue:114-123` inside one `Promise.all`, so they are in flight
simultaneously and their `syncDB` calls land in whatever order the network
finishes. Their payloads are partial, and partial in different ways:

    /rooms/        every room you are in
    /rooms/recents only the 10 most recently active (`RecentRoomsAPIView`)
    /messages/     rooms rebuilt from *pending messages only*, and users from
                   just those rooms' participants (`MessageViewSet.list`)

So the same room and the same user are written by several of them and the app
needs the **union**. That holds only because `SET_ROOMS` and `SET_USERS` merge
additively instead of clearing - which is the opposite of every other setter in
this store (`SET_SENT_INVITATIONS` and `SET_RECEIVED_INVITATIONS`,
`mutations.js:174-186`, both reset to `{}` first). Nothing in the code says the
distinction is deliberate and nothing would notice if it stopped: a symmetric
"fix" that made `SET_ROOMS` clear first would leave every test green and make the
sidebar show only whichever rooms' messages happened to be pending.

**A false claim in production source, found on the way.** `mutations.js:3-8`
justified the id-sort with "in that order, because App.vue awaits fetchRooms
before fetchMessages", and `room_message_order.spec.js:8` repeated it. App.vue
does not: `:114` is a `Promise.all`. The awaits were replaced at some point and
the comment kept the guarantee that used to hold. Since that comment is the
stated justification for the sort, and the sort is load-bearing, both comments now
say the real reason - the arrival order is *unspecified* - instead of a sequencing
claim the app stopped making. Correcting `room_message_order.spec.js` too, since
it is the file that pinned the order the comment described.

**No defect.** `syncDB`'s payload contract holds against all three callers: I read
`RecentRoomsAPIView.get` and `MessageViewSet.list` and both return exactly
`{rooms, messages, users}`, so nothing is silently dropped. And the merge is
order-independent under all six arrival orders of all three writers, which is
what item 9 bought and what had never been checked at the layer that can produce
any of the six. Six tests in `tests/unit/load_path.spec.js`.

**The finding worth more than the coverage.** `all three landing together` and the
two-way pair both pass, but under reversion L4 - `mergeMessages` stops sorting -
L4 killed *"loading in the order the comments describe"* and **did not kill**
*"loading in the other order"*. That is not a gap in the reversion; it is the
proof that the two tests are not the same test. Append-only happens to produce
the right array when the older batch arrives first, so the reverse-order test
passes for a reason unrelated to the sort. **Neither test alone detects item 9's
original bug** - the forward-order one does, and the reverse-order one is what
stops a future fix from buying forward order back at the cost of reverse. Each now
asserts its own intermediate state (`[5]` / `[1,2,3,4]`) so the arrival order
under test is asserted rather than assumed.

**Five reversions, each killing exactly its named test:**

    L1  SET_ROOMS clears before merging   -> narrow-payload test only
    L2  SET_USERS clears before merging   -> narrow-payload test only
    L3  syncDB crosses rooms and users    -> the three-keys test only
    L4  mergeMessages stops sorting       -> the order-described test
                                            (+ all-three-together)
    L5  syncDB commits messages only      -> the three-keys test
                                            (+ no-messages-yet)

L5 killing two is the honest shape, not a leak: the no-messages-yet test asserts
`state.rooms[11]`, so it depends on `SET_ROOMS` running. Every restore was verified
by text compare against the pre-reversion file.

**Measurement corrected, not corrected.** My own note going into this item claimed
item 69 recorded that `actions.js` reached 100% statements and that the figure
needed correcting. It does not - `:4513-4518` says 18.52% statements and 100%
branch, which is what the coverage run reproduced. No correction to PLAN.md was
needed for the numbers; what is corrected above is the *shape* claim, "twenty-one
straight-line axios wrappers", which was wrong about three of them.

pytest **244** unchanged - no backend file was touched. jest **192** -> **198**,
**35** -> **36** suites. No production code changed, only two comments, and the
bundle is untouched: `bundle.js` md5 `2c1753ea...`, with the reason checked rather
than assumed - four distinct phrases from the `mutations.js` comment block appear
**0** times in the committed `bundle.js` while `LINK_MESSAGES_TO_ROOM` appears
once, so minification strips comments and keeps code and a comment-only edit
cannot move the bundle. Nothing committed.

### 75. The composer was a single-line box offering 500 characters

The first Phase 2 item, and the only real gap the survey below found. Found the
way items 1-3 were found - an existing thing with no way to reach it - except the
thing that turned out to have no way to reach it was **the message input**.

`SendForm.vue:5-14` was:

    <input type="text" ... @keyup.enter="sendMessage()" />

Two consequences, and only one of them is about keys. A single-line input cannot
*represent* a newline, so there was no way to compose a message spanning more
than one line at all - and separately, every Enter sent, Shift included, so the
one combination that should mean "break the line" meant "send" as well.

The cap is what makes this more than cosmetic. `maxBody` is 500
(`SendForm.vue:48`), pinned against Django's `Message.body max_length` by
`send_form_maxlength.spec.js`. So the composer was offered 500 characters and
could hold roughly one line of them, in an app whose entire premise is
messaging.

**Fixed** with the platform, not with code: `<textarea rows="1">`, and
`@keydown.enter.exact.prevent` where it was `@keyup.enter`. `.exact` is Vue's own
guard - it compiles to `if ($event.shiftKey) return null` - so a shifted keypress
never reaches the handler and the browser's newline insertion stands.
`keydown` rather than `keyup` because `.prevent` has to stop the newline on an
*un*shifted Enter, and a newline is inserted on keydown: a `keyup` handler would
let it appear for a frame before the send cleared it. Two modifiers, no handler,
no keyCode arithmetic.

Plus `resize()`, because a `rows="1"` box that never grows shows one line of a
500-character message and scrolls the rest out of sight. It is hooked to the
**existing** `body` watcher rather than a new `@input`, so the three ways the
body changes are covered once - typing, the clear after a send, and the draft
the room watcher throws away. It collapses to `auto` before measuring, or the box
can shrink on delete but never recover.

**Five tests**, `tests/unit/send_form_multiline.spec.js`, and the failures before
the fix were the defect rather than a missing element:

    Shift+Enter does not send            Expected 0 calls, received 1
    Shift+Enter leaves what was typed     Expected "first line", received ""
    the composer can hold a line break    no <textarea> in the tree

That distinction was the first draft's mistake. It selected `find("textarea")`,
so three tests failed with "cannot call trigger on an empty Wrapper" - reporting
the absent element instead of the bug. The behavioural tests now use
`find("textarea, input")` and can fire against the old `<input>`, which is what
makes `Received number of calls: 1` evidence rather than a missing element.
They also do **not** claim Shift+Enter inserts a newline: that is the browser's
default action and jsdom does not perform it, so asserting it would test jsdom.

**Two reversions, each killing exactly its named tests:**

    R1  drop `.exact`                    -> both Shift+Enter tests
    R2  back to a single-line <input>    -> the line-break test
                                            (+ send_form_maxlength's, which is
                                            the one selector in the suite that
                                            named the old tag - updated to
                                            `textarea`, with the reason in a
                                            comment rather than a bare edit)

pytest **244** unchanged - no backend file was touched. jest **198** -> **203**,
**36** -> **37** suites.

**Bundle rebuilt** - `src/` changed, so this one is a real rebuild rather than
item 74's comment-only no-op. `bundle.js` `2c1753ea...` -> `d20fe02f...`, with
`rows:"1"` and `style.height` both present in the output.

`bundle.css` moved to `6f00b828...` and **one** of the new rules is this item's:
`.resize-none`, from the class that suppresses the textarea's drag handle.
`overflow-hidden` was already there. That corrects something I said mid-item: I
assumed Tailwind 1.x is a full build that emits every utility regardless of use,
so an added class could not change the CSS - wrong, this build is purged, and
`.resize-none` is present now where it was absent before. The other 18 selectors
new against `HEAD`, and the two changed `.sticky` blocks, belong to items 49-74,
which are also uncommitted - `git diff` compares against `bc60acb` and cannot
attribute them, so the rule-set diff (not the byte count) is the evidence.

### 76. Message search, which could not be a client-side filter

Phase 2's first real gap. The box is the small part; three decisions under it are
the item.

**Server-side because the client cannot do it.** A room opens with the newest
**ten** (`messageViews.py:105-106`) and the store holds those plus whatever has
been paged in. A filter over `state.roomMessages` would answer "no such message"
for every message outside those ten -- worse than no search, because it looks
like an answer. Pinned so a client-side version cannot look correct:
`test_search_reaches_back_past_the_ten_the_room_opened_with` puts the needle in
first, then 30 messages after it, and only finds it through the endpoint.

The whole server change is three lines, because `?search=` narrows a queryset
the paging branch already had:

    search = self.request.query_params.get('search')
    messages_qs = room.messages
    if search:
        messages_qs = messages_qs.filter(body__icontains=search)

**`icontains`, not `contains`** -- LIKE is case-sensitive on Postgres and a search
box is not case-sensitive to the person holding it. Same for `+` in an email,
which item 65 already had to learn the hard way.

**Results get their own store map.** `searchResults` is not `roomMessages`, and
the reason is the one item 71 and item 73 spent their reversions on: hits are
the same messages with most of their neighbours missing, so linking them in the
way every other message arrives would splice ten orphans into the middle of a
conversation and move everything below them. Pinned by asserting
`SET_SEARCH_RESULTS` **and** that `LINK_MESSAGES_TO_ROOM` is not among the
commits.

**`encodeURIComponent` on the term** -- the only place a user-supplied string
reaches a URL, and the reason the test types `the&other=x`: unencoded that is a
search for "the" with an unrelated parameter attached, which runs, returns the
wrong things, and says nothing about it.

**A refusal has to be visible.** `searchError` is set where the rejection lands,
and rendered in a `role="alert"` paragraph. Without it a failed search and a
conversation with nothing matching are the same screen.

### 76a. Two defects found on the way, both from the existing suite

Neither was in the plan; both are things this item's own code caused, and both
were caught by specs written for other items rather than by this one's.

**`focus_ring.spec.js` -- my search box had no focus indicator.** It used
`focus:outline-none` with nothing to replace it, which is the exact defect that
spec exists to keep out (five offenders listed in its header). Fixed with
`focus:shadow-outline`, the codebase's own indicator, already in the build.

**`keyboard_reach.spec.js` -- two tests began asserting against the wrong
element.** Both reached the go-to-bottom button with `find("button")`, which
stopped being unambiguous the moment a search bar with its own button went above
it. That file's header already records this having happened once, for the menu,
and it fixed it by stubbing `Menu` rather than by making the selector robust. Same
failure, second time, so the selector is now `.sticky button`. Worth writing down
twice over: the stub closed one instance of "whatever this component happens to
render today", and the class of bug outlived the instance.

### 76b. One of my own five tests measured the mock

Reversions, each breaking exactly one thing:

    R1  drop focus:shadow-outline      -> nothing removes the focus ring
    R2  commit LINK_MESSAGES_TO_ROOM   -> results land in their own map
    R3  drop encodeURIComponent        -> a term with an ampersand
    R4  drop closeSearch() in watcher  -> changing room drops the results
    R5  drop the empty-term guard      -> NOTHING

R5 was the honest one. The test asserted `mockGet` was not called -- and
`$store.dispatch` is a mock in that harness, so no search could reach
`mockGet` whether or not the guard was there. It now asserts on
`wrapper.vm.$store.dispatch`, which the guard actually stops, and R5 kills it.

`?offset=abc` also found on the way past: the paging branch did `int()` straight
off the query string, so one bad query parameter was a 500 on a read-only
endpoint. `ParseError`, the codebase's own answer to bad input, and pinned --
plus the neighbouring input measured rather than assumed, `?offset=0` being a
200 for the newest page because the branch is `if offset:` and 0 is falsy.
Unreachable from any client (`messages[0].id`, and ids start at 1), so left
alone and written down instead.

pytest **244** -> **248**. jest **203** -> **210**, **37** -> **38** suites.

**Bundle rebuilt** -- `bundle.js` `d20fe02f...` -> `793eab26...`, `bundle.css`
`6f00b828...` -> `beace0b5...`. Five new CSS rules are this item's:
`.bg-gray-100`, `.bg-red-100`, `.text-red-700`, `.hover:bg-blue-600:hover` and
`.hover:bg-gray-300:hover` (the `code`/`fieldset`/`legend` preflight entries
arrive with them). `focus:shadow-outline` is not among them, because
`focus_ring.spec.js` asserts it was already in the build.

### 76c. What this does not do

- **A search returns at most ten hits.** `[:10]` on line 105 is the endpoint's
  existing cap and a search inherits it, so "10 messages matching" can mean ten
  of four hundred. Paging a search needs a cursor the endpoint does not have.
- **Bodies only.** Searching for a person's name finds nothing, and the composer
  says nothing about that.
- **A search does not disturb the thread**: it does not page, does not mark the
  room read, and does not move `messages`. Switching rooms drops the hits
  (`closeSearch()` in the watcher), because one map for the whole app cannot tell
  a stray hit from a real one -- every result carries its own `room` and nothing
  compared it to the selection.

### 77. Day separators in the thread, and a key I had to stop calling load-bearing

Phase 2 item 2. The dates were the easy half: every bubble already renders
`{{ time }}` at `hh:MM` (`SentMessage.vue:64`, `ReceivedMessage.vue:46`), so the
reader has the information and has to count back through the bubbles to use it.

One computed, `dayGroups`, groups the flat `roomMessages` array by local
calendar day, and the template nests one `v-for` inside another. Grouping happens
in the component rather than in the store on purpose: `roomMessages` is a flat
array that three writers merge into (`mergeMessages`), so a nested structure
would have to be rebuilt by all of them for the convenience of one reader.

`dateformat`, already a dependency and already what both bubbles use for
`hh:MM`, formats the label: `Today`, `Yesterday`, or `dddd, mmmm dS`. Yesterday
is found with `setDate(getDate() - 1)` rather than `midnight - 86400000`, which
is an hour out either side of a DST change -- and this is the code that runs on
the day of one, once per group.

**No day header on search results**, pinned, because the alternative is a
future well-meaning change: hits are the same messages with most of their
neighbours missing, so a date above one reads as though it headed the thread.

**A guard I wrote and then deleted.** The first draft returned an empty label for
an unparseable `timestamp`, on the theory that one bad row should not take the
thread down. Measured instead: `dateformat` throws on an Invalid Date, and
`SentMessage.time` and `ReceivedMessage.time` already call it on that same value
-- so the bubble dies first either way, and the guard protected nothing. Deleted
rather than left as untested defence.

**Reversions, each breaking exactly one thing:**

    R2  group per timestamp, not per day   -> every message still renders once
    R3  print today as a date              -> a day boundary gets a header
    R1  inner v-for keyed by index         -> NOTHING
    R4  outer v-for has no key             -> NOTHING

R2 survived the first run, and the fault was the fixture, not the assertion: two
of its same-day messages shared a `timestamp`, so they shared a group however the
component grouped. `bubble()` now gives every message its own minute, with the
reason in a comment -- a fixture where same-day messages are byte-identical in
time cannot distinguish per-day grouping from per-timestamp grouping.

### 77a. R1 and R4 are a true negative, and PLAN.md was wrong about the key

This entry was filed as "the `v-for` becoming a nested one is the cost, and that
`:key` is load-bearing for items 71-73". Half of that sentence does not survive
its own reversion: **keying the inner list by index instead of `message.id`
changes nothing the suite can see** -- and, having looked, nothing a user can
see either.

Three measured reasons:

- `LINK_PAST_MESSAGES_TO_ROOM` prepends, but only whole *earlier days*. A message
  older than everything loaded is on an earlier day, so paging adds a group
  rather than shifting a message to a new index inside a group.
- An incoming message appends, so it never moves an existing index.
- Both bubbles are stateless -- computeds and props, plus `created()` on
  `SentMessage` -- so index-keyed patching, which reuses one child instance for
  two different messages, renders the same DOM.

So items 71-73's suite never mounted a thread whose `v-for` had lost its key,
and this item's nesting does not create the first such case. The keys stay: each
is one attribute, they are what Vue wants, and a `v-for` without one is a warning
-- but "load-bearing" is withdrawn. It was a plausible story repeated from the
item that wrote the key, which is the third time in this file a justification has
outlived its evidence (item 69's coverage claim, item 74's `App.vue` ordering
claim, this one).

pytest **248** unchanged - no backend file was touched. jest **210** -> **216**,
**38** -> **39** suites.

**Bundle rebuilt** - `bundle.js` `793eab26...` -> `81af3ac1...`, `bundle.css`
`beace0b5...` -> `50da5965...`. **Zero new CSS rules**: `.day-separator` is a
test hook with no rule of its own, and `text-center text-xs text-gray-600 py-2
select-none` were all already in the build. The CSS still moved because editing a
`.vue` file renames its scoped `data-v-` hashes - the rule-set diff is empty,
which is the evidence, not the byte count.

### 78. Fifteen actions no test had ever run

The first measurement-driven item since the Phase 2 backlog ran out. A coverage run
put `actions.js` at 34.8% of lines with **every other file under `src/` at 100%**,
and `coverage-final.json`'s `fnMap` named which fifteen:

    markMessageAsRead  fetchUnreadMessages  postWriting  markRoomAsRead
    fetchSentInvitations  addFriend  cancelFriendRequest
    fetchReceivedInvitations  rejectFriendRequest  acceptFriendRequest
    deleteRoom  fetchUserProfile  patchUserProfile  fetchRoomActivity
    createGroup

Eight of the fifteen were *apparently* covered, by tests that mock
`$store.dispatch`. Those pin **that an action was requested**; the action never
runs, so its URL, its HTTP method and its commit were all unpinned.
`invitations_refusal.spec.js` is the clearest case: "all three actions report a
refusal" is a claim about the component's `.catch`, and accept, reject and cancel
had never issued a request.

**The negative came first, and no defect was filed.** All fifteen URLs and methods
were cross-referenced against `chat/api/urls.py`, `friends/api/urls.py` and
`users/api/urls.py` and their view classes, and every one matches. That includes
`messages/unread`, which is one path serving both a GET (`fetchUnreadMessages`) and
a POST (`markMessageAsRead`) because `UnreadMessagesAPIView` implements both -- the
read receipt carries `message_id` in the query string, which is the only thing
telling the two apart.

Two suspicions I had and disproved rather than filed:

- `deleteRoom` looked like it left a stale sidebar row, since it commits nothing.
  It does not: `RoomDeleteAPIView.post` sends `room_delete` *before* deleting, and
  `App.vue:50-55` answers with `REMOVE_ROOM`. This is pinned as **committing
  nothing**, and it is the assertion most likely to be argued with -- a local commit
  here would look like a fix, and would remove the row for the deleter while leaving
  the peer with a room that 404s.
- `createGroup` had already been fixed in item 51.

`tests/unit/action_contracts.spec.js` -- 11 tests. What is pinned is that a
hand-edited URL is a red test rather than a 404 in a browser console nobody is
watching: the PATCH on `/api/v1/me` (`CurrentUserAPIView` is a
`RetrieveUpdateAPIView` and answers both, so a POST there is a 405), the three
different verbs on `/friends/requests/`, `kind: 2` on group creation (`kind: 1` is
a private room, which `RoomViewSet.create` refuses unless the list is exactly two),
and the read receipt's `?message_id=`.

**Reversions, each breaking exactly one thing, each killing exactly one test and
nothing else:**

    R1  profile written with POST, not PATCH  -> your own profile is read with GET
    R2  reject posts to the accept endpoint   -> the three things you can do
    R3  deleteRoom also commits REMOVE_ROOM   -> deleting a chat commits nothing
    R4  group created as kind 1               -> a group is created with kind 2
    R5  unread asked for without /unread      -> unread messages come from unread
    R6  read receipt drops ?message_id=       -> a read receipt carries the query

**What I did not test, and why.** `actions.js` is at 83.0%, and the remaining 17%
is twenty structurally identical `.catch(error => reject(error))` forwards -- one
line each. `grep -n "catch(" | grep -v reject(error)` returns exactly one hit,
`actions.js:109`, which is `sendMessage`'s and which `action_requests.spec.js`
already pins with "a refused send takes the message off its clock". Nineteen more
tests asserting that nineteen catches re-reject an error would be coverage for its
own sake.

pytest **248** unchanged - no backend file was touched. jest **216** -> **227**,
**39** -> **40** suites. Coverage: `actions.js` **34.8% -> 83.0%**; totals now lines
**86.6%** (214/247), functions **75.4%**, branches **69.4%**. **No bundle rebuild**
- nothing under `src/` changed, so `static/dist/` is untouched.

### 78a. The mirror image: eight of those commits are themselves never run

Item 78 pinned that the actions *request* the right commits. `mutations.js`, the
other file not at 100%, says the commits themselves have never executed. Eleven
functions, none invoked by any test:

    line 125  SET_SEARCH_RESULTS  (its forEach body)   line 200  SET_USER_PROFILE
    line 129  SET_SELECTED_ROOM                       line 203  SET_CURRENT_WIDTH
    line 132  REMOVE_ROOM                             line 206  SET_CURRENT_HEIGHT
    line 187  SET_SENT_INVITATIONS   (+ its forEach)   line 209  SET_ROOM_ACTIVITY
    line 194  SET_RECEIVED_INVITATIONS (+ its forEach)

Seven of the eight names are exactly the commit targets item 78 began asserting,
so the gap is the mirror of the one just closed: a `jest.fn()` where a mutation
should be. The cause is visible in the specs -- `closed_room.spec.js:47` and
`keyboard_reach.spec.js:51,84` mount with `commit: jest.fn()`,
`window_size.spec.js:40` with `const commit = jest.fn()`, and
`action_contracts.spec.js` passes `{ commit: commits }`.

So this is not new design: `load_path.spec.js:70` already wires `commit` to the
real mutations and says why in a comment, and that spec is the reason
`mutations.js` sits at 77% rather than 33%. The fix is to copy one existing
pattern into four specs, and the thing to watch is item 70's rule -- adding a
*key* to these maps needs `Vue.set`, and `action_contracts.spec.js`'s state would
have to be `Vue.observable` or the mutations write into a plain object nothing
renders.

### 79. The eight commits item 78 asked for, run for the first time

Item 78a filed the mirror gap; this closes it. `tests/unit/mutation_contracts.spec.js`
-- 4 tests, calling the mutations as plain functions over a plain object, which is
`unread_axis.spec.js`'s rule rather than a new one.

Five of the eight are one line each, `state.x = payload`. Those are not tested one
per mutation: one table, one test, because what is worth pinning is the **pairing
of each commit name to the field it lands in**, not the assignment, which is the
language's. Every caller of those five is a `jest.fn()`, so a mutation renamed in
`mutations.js` and left behind in four places would write into a field nothing
renders and pass every test in the repo.

`REMOVE_ROOM` gets a test because it is what `App.vue:50-55` answers the
`room_delete` push with -- the entire basis for item 78's "commits nothing"
assertion -- and because a removal that took the map with it would empty the
sidebar while one that took too much would leave a row pointing at a room that
404s. It also has to survive a room this store never had: someone else's push can
name a chat the row was already removed for on their screen.

The three list mutations get the "replace, not merge" claim, because that is the
load-bearing word in all three -- `addFriend` and `cancelFriendRequest` both commit
`SET_SENT_INVITATIONS` (`actions.js:195,206`), so a merge leaves every invitation
you ever sent on screen for the rest of the session.

**Reversions, each breaking exactly one thing:**

    M1  SET_SELECTED_ROOM writes to the wrong field -> each plain mutation writes
    M2  REMOVE_ROOM empties the whole map          -> removing a chat
    M3  a list mutation adds instead of replacing -> the three list mutations
    M4  an empty list stops emptying the map      -> an empty list is what empties

M3 and M4 each also break the other's test, and that is not two claims happening
to overlap: "replace rather than merge" and "an empty list empties the map" are
one mechanism -- reset, then re-add -- seen from two angles. Recorded rather than
split, because a fourth test distinguishing them would be testing the same line.

**A test I wrote that asserted my own bad reasoning, and rewrote.** The first
draft said `SET_SEARCH_RESULTS(state, [])` is safe because of the `if (messages)`
guard, and the fourth test asserted that `[]` reaches it. It does not: an empty
array is truthy, so the guard never runs on that path, and it is `[].forEach`
iterating zero times that empties the map. What the test now pins is the real
mechanism, which also makes it survive an "add to whatever is there" reversion
that the earlier version would have passed.

**Two guards measured rather than tested, and one of them does not exist.**
`SET_SENT_INVITATIONS` and `SET_SEARCH_RESULTS` read `if (messages)`;
`SET_RECEIVED_INVITATIONS` does not, which reads like an oversight. It is not
reachable-as-a-defect from any current caller: all three of the received-tab
callers (`fetchReceivedInvitations`, `rejectFriendRequest`, `acceptFriendRequest`)
commit `response.data` from a view ending in `Response(serializer.data)`
(`friends/api/views.py:65,86,125,135,158`), so the payload is always a list -- and
by the same measurement the *guarded* two are never handed a falsy payload either.
So no test here exercises any of the three guards, and none pretends to. Adding the
missing one would be a branch no test could reach.

**What this does not pin.** `Vue.set` versus a bare assignment inside these
mutations is invisible to a plain-state test, exactly as `unread_axis.spec.js`
states in its own header. Item 70's rule -- a *new key* on a reactive object needs
`Vue.set` or nothing re-renders -- is covered where it is observable, by specs that
mount with `Vue.observable` state, and it is not covered here.

pytest **248** unchanged - no backend file was touched. jest **227** -> **231**,
**40** -> **41** suites. `mutations.js` **77.4% -> 100% of lines and functions**;
totals now lines **92.3%** (228/247), functions **84.4%**, branches **72.2%**. Every
file under `src/` is now at 100% except `actions.js`, and its remaining 17% is the
twenty identical `reject(error)` forwards item 78 recorded. **No bundle rebuild** -
nothing under `src/` changed.

### 80. The first backend coverage measurement, and one string that named half a row

The frontend measurement lane is finished -- every file under `src/` at 100% except
`actions.js`'s twenty identical `reject(error)` forwards -- so this is the same
method pointed at the other half of the repo.

`coverage` 7.16.2 was already in the venv; `pytest-cov` was not, and I did not add
it (`coverage run -m pytest -m coverage json` is all this needed, and
`pytest-json-report` was likewise refused rather than installed for the reversion
script's benefit). **Every backend file carrying real logic is at 100%** --
`messageViews.py` 81 statements, `roomViews.py` 134, `views.py` 26, `consumers.py`
17, `signals.py` 21 and 17, every serializer, every migration, `settings.py`,
`urls.py`, `asgi.py`, `core/views.py` -- with two exceptions.

**The defect: `friends/models.py:112`.** `FriendshipRequest.__str__` returned
`"%s" % self.from_user_id`. All four relationship models are registered in
`friends/admin.py:26-29`, so that string *is* the admin changelist column and the
label you pick a request out of, and it identified a row by one of its two ends.
The other three `__str__`s in the same file already name both sides -- "User #%s
is friends with #%s", "follows", "blocks" -- so this was the odd one out rather
than a deliberate shorter format. Fixed to the file's own convention.

The test failed first, for the stated reason:

    AssertionError: FriendshipRequest shows '3', which does not name both sides

and it asserts the *convention* across all four models rather than one string, so
the next model to skip a side is a red test too.

**What I suspected and checked instead of filing.** `are_friends` queries one
direction -- `Friend.objects.get(to_user=user1, from_user=user2)` -- while
`remove_friend` four lines above it uses a two-sided `Q | Q` on the same table.
That reads like a friend pair stored in two orders and read in one. It is not:
`FriendshipRequest.accept` (`models.py:117-123`) does **two** `get_or_create`s, one
per direction, so both rows exist and the single-direction read is correct. No
defect, and the asymmetry that looked like one is now explained in place.

**Measured negatives, none of them filed as gaps:**

- `remove_friend`'s `except Friend.DoesNotExist: return False` (`models.py:418-419`)
  is unreachable. The guarded body is a `filter()`, which never raises
  `DoesNotExist`; only `get()` does, as in `are_friends` below it. Dead, harmless.
- Four of the six lines still uncovered are on the Follow/Block axis -- `follows`
  and `is_blocked`'s `return True`, and the self-follow and self-block
  `ValidationError`s. Grepped rather than assumed: `add_follower`, `add_block`,
  `is_blocked` and `follows` have **no caller outside `models.py` and the tests**,
  and neither word appears in any `urls.py`. That axis is the dead one already
  recorded below as your call to make, not a coverage gap.
- `manage.py`, `wsgi.py` and `djchat/routing.py` sit at 0% because no test imports
  an entry point. The third of those is the dead duplicate item 42 recorded and
  nobody has deleted.
- `friends/api/test.py` at 91.6% is the vendored Django 1.x stub suite, dead in the
  same way and recorded below.

`friends/models.py` is now **98.2%** (329/335), up from 96.7%, with every remaining
line accounted for above.

**Reversions, each breaking exactly one thing:**

    N1  __str__ back to the bare sender id -> names both sides
    N2  drop the second cache lookup in are_friends -> answers from either cache

N2's test is worth its two lines of setup for a reason that is not visible in the
assertion: both cache branches `return True`, so the claim is not that the second
key gives a different answer, it is that the key is *read*. Dropping it falls
through to the `DoesNotExist` below and answers False -- which `add_friend`
(`models.py:343`) reads as "not friends yet", and would open a second friendship
request between two people who are already friends. Both reversion cases killed
exactly their named test and nothing else.

pytest **248** -> **250**. jest unchanged at **231** / **41** suites. **No bundle
rebuild** - no frontend file was touched.

### 81. Is 100% coverage protection, or only execution?

Item 80 left the repo with every backend file carrying real logic at 100% and every
file under `src/` at 100% except `actions.js`. That is a statement about execution,
not about whether a test would *notice*. This is the measurement that distinguishes
them: eleven reversions over production code that coverage already says is exercised,
each run against the **whole** suite, because a narrow run reports a false survivor
whenever the test that would notice lives in another file.

    Backend, 5 of 5 killed
      bust_cache stops busting               -> 10 tests
      add_friend stops refusing yourself      ->  3 tests
      accept() stores one direction only      ->  9 tests
      ?search= stops filtering                ->  3 tests
      deleting a chat stops unfriending       ->  2 tests

    Frontend, 2 of 6 killed
      the room_update push stops refetching    -> SURVIVED
      the typing push stops emitting           -> SURVIVED
      closing the drawer stops emptying it     -> SURVIVED
      the viewport is never stored              ->  3 tests
      ReceivedMessage's unread check -> true    -> SURVIVED
      the initial load stops fetching rooms     ->  2 tests

So the backend's 100% is real protection and the frontend's was not, in three
places. Deliberately not re-run here: `position()`, the `receivedMessages` cleanup,
the search reset, the "Yesterday" branch and the composer's maxlength. Items 71-77
already reverted all five, and re-running them would only re-confirm a result this
file already records.

**A hypothesis of mine that was wrong, and is worth keeping.** Before running the
sweep I predicted `bust_cache` would survive with zero killers, on two grounds:
`conftest.py:14-21`'s autouse `cache.clear()` runs before and after every test, so
busting is unobservable; and `test_removed_friends_disappear` never populates the
cache before removing, so it cannot be what protects it. Both are true -- I checked
both. Ten tests died anyway, nine of them live ones in `friends/_tests/` and only
one in the vendored `friends/api/test.py` stub suite. Recorded because the reasoning
was sound and the conclusion was not, which is the useful shape of that sort of thing.

### 82. Three of the four survivors, and what they actually were

Four tests, each pinned to the case that survived.

**F1 and F2, `tests/unit/push_handlers.spec.js`** (new). `websocket_reconnect.spec.js`
closes with "everything below is about *when* the socket is connected, not what
happens" inside it -- and nothing covered what happens. The harness is that file's:
`App.methods` pulled out and called against a fake socket, with a `$store` and the
EventBus added.

F1 is the branch item 78's spec **argues from**. `action_contracts.spec.js` pins
`createGroup` as committing nothing, on the grounds that "the group reaches every
participant's sidebar off the `update_rooms` push the view sends, which
`App.vue:48-49` answers with `fetchRooms`". Every word of that argument had been
checked except the part it rests on. Delete `App.vue:48-49` and a group you create
never appears for anyone else, with no error anywhere, and item 78's spec stays
green because it asserts what the action does *not* do rather than what the push
then does.

F2 is the middle hop of a chain whose every other link is tested: `postWriting`
(item 78), `RoomWritingAPIView` (pytest), `User.vue`'s `$on("writing")`
(`user_writing_listener.spec.js`). The one place the push becomes an event had no
test, so "X is writing..." could vanish and 231 specs would pass.

**F3, `tests/unit/closed_room.spec.js`.** That file's header names
`SideRooms.vue:62` as one of three ordinary gestures that commit
`SET_SELECTED_ROOM(null)`, and then pins none of the three: every case there drives
`MessagesSection` directly with `commit: jest.fn()`. It is the only one of the three
that is a gesture rather than an event.

**F5, `tests/unit/incoming_message.spec.js` -- and the sweep's label for it was
wrong.** The case was called "the unread tick is drawn for every message, not just
unread ones", on the assumption that `ReceivedMessage.vue:70` gates a tick. It does
not: **that component renders no tick icons at all** -- the read-receipt display
exists only on sent messages, which is a design decision and not a gap. The check at
:70 is inside `markMessageAsRead`, so what the reversion actually broke was the
**auto-read dispatch**: opening a chat is the only thing that marks the peer's
messages read, and it does so without a click. With `if (true)`, every received
bubble posts a read receipt whether or not it was unread. The test is written
against that, and against both messages in one thread so the guard has to hold.

Re-running the sweep afterwards: **6 of 6 killed**, and each of the four new ones
killed by exactly the test named for it and nothing else.

pytest **250** unchanged - no backend file was touched. jest **231** -> **235**,
**41** -> **42** suites. **No production file changed**, so **no bundle rebuild**.

### 83. The largest module in the repo, and the two branches nobody was watching

Item 81 swept across files; this one sweeps *within* the biggest one.
`chat/api/roomViews.py` is 134 statements and had had exactly one branch ever
reverted (item 81's S5, unfriending on room delete). Seven cases, each breaking
one thing coverage says is exercised, each run against the **whole** suite.

**Four were already protected**, and by tests that had read the code rather than
inferred it -- worth recording because they are the counterweight to the two
that were not:

| | killed by |
|---|---|
| R1 empty activity day plots zero instead of `KeyError` | 6 tests in `test_room_activity.py` |
| R3 typing push stops carrying `user_id` | `test_signalling_that_you_are_writing_pushes_both_ids` |
| R5 CSV export of a message with a comma and a newline | `test_csv_quotes_a_message_containing_a_comma_and_a_newline` |
| R6 `?as=xml` served as JSON instead of refused | `test_an_unknown_format_is_rejected` |

**R2 and R4 survived, and both are load-bearing.**

**R2 -- `room.participants.exclude(id=request.user.id)` -> `.all()`.** The
typist's own socket is not opened by any test: `push_received_by` opens the
*listener's*, and the three writing tests in `test_room_api.py` assert nothing
but a 204. It matters because `User.vue:120` filters a writing push on
`room_id` alone -- there is no `user_id` check anywhere in `onWriting` -- so a
push echoed to its sender renders as **your own name above the chat you are
typing in**, for the full ten seconds the timeout runs. Fixed by a test, not a
line of code: the exclusion is correct.

**R4 -- `participants.union(set(room_data['participants']))` -> `set()` in
`RoomViewSet.list`.** The tempting misreading is that this blanks the sidebar,
because every room title is `room.group_name`. It does not. The damage is that
`state.users` is **empty**, and that map is what `fetchRooms` fills from this
very response (`syncDB` -> `SET_USERS`, keyed by id). Two readers resolve
against it and both fail quietly: `User.vue:126` looks a typing push's
`user_id` up and `:127` falls back to `""` when it misses, so **the typing
indicator never names anyone, ever**; `ReceivedMessage.vue` does the same for a
message author. No error, no console message, an app that looks fine and simply
never says who is typing.

The same loop is repeated **byte for byte** in `RecentRoomsAPIView` twenty lines
below, so R4b sweeps that copy too. One test covers both endpoints rather than
two -- three extra lines against a duplicated body is the cheap direction.

Re-running: **7 of 7 killed**, R2/R4/R4b by exactly the test named for them and
nothing else, R1/R3/R5/R6 by the pre-existing ones.

pytest **250** -> **252**. jest **235** unchanged. **No production file
changed**, so **no bundle rebuild**.

Not swept, and the reason is worth stating: the *emission* side of the pushes
(`chat/signals.py`, `friends/models.py:129,156,170,377`) reads as already
pinned end to end -- `chat/_tests/test_consumer.py:190-195` carries a table of
which push maps to which action, and lines 264-330 assert the destination and
payload of each one. Sweeping it would have been motion, not measurement.

### 84. The second-largest API view file, and one survivor that was not a defect

`chat/api/messageViews.py` is 188 lines and 81 statements. Item 46 swept
`chat/api/serializers.py`, not this file, and item 80 only *measured* it -- at
100% statements, which is what item 81 then showed is not the same thing as
being protected. It had never been reverted on purpose. Ten cases, whole suite.

The harness carries item 46's one unfinished fix. That item recorded that its
runner "does not check that the mutated file still imports, and it should",
because one of its eleven probes produced an `IndentationError` and a runner
that only asks "was the exit code non-zero?" scored that as a kill. Here an
unimportable mutation is reported as a **harness error**, not a kill. No case
tripped it.

| | killed by |
|---|---|
| M1 a read receipt posts nothing | `test_message_starts_unread_and_disappears_once_read`, +1 |
| **M2 `unread_messages.get` -> `Message.objects.get`** | **survived** |
| M3 paged history newest-first | `test_offset_walks_backwards_through_history` |
| M4 `?search=` matches nothing | the three `test_search_*` |
| M5 room payload stops shipping authors | `test_recent_per_room_returns_its_room_and_the_message_authors` |
| M6 pending list stops shipping users | `test_pending_response_carries_the_related_rooms_and_users` |
| M7 a stranger publishes into a room | `test_cannot_post_into_a_room_you_are_not_in` |
| M8 the sender marks their own message read | `test_created_message_becomes_unread_for_the_other_participant` |
| M9 a room you are not in is readable | `test_cannot_see_another_rooms_messages`, +1 |
| M10 `?offset=abc` answers with the newest ten | `test_a_non_numeric_offset_is_rejected_not_a_crash` |

**M2 survived, and it is not a defect -- it is a redundancy, and no test could
pin it.** `chat/models.py:41-43` declares
`pending_read = models.ManyToManyField(..., related_name='unread_messages')`, so
`request.user.unread_messages` **is** `Message.objects.filter(pending_read=the
user)`. Swapping the two lookups changes the queryset's identity, not its
contents. And for a message you have nothing to do with, the mutated path is
already inert: `Message.mark_as_read` is guarded by its own
`if self.pending_read.filter(id=user.id).exists()` (`models.py:79`), so the
stray call does nothing and the endpoint's idempotent 204 absorbs it.

`test_cannot_mark_someone_elses_message_as_read` exists, asserts exactly the
right thing, and passes under the mutation **because the outcome really is
identical**. That is not a weak test. This is item 35's `elif` cache branches
again: there is no behaviour there to pin, and a test would assert only that
the code still says what it already says. Filed as a negative.

**A contaminated run, and what it cost.** The first sweep reported M10 killed
by *four* tests, three of which -- `FriendshipModelTests`,
`test_password_is_hashed_not_stored`, `test_registering_creates_an_active_user`
-- have no relationship to the `offset` parse. The cause was mine: I ran
`pytest test_room_api.py` while the sweep was still going, and two pytest runs
sharing one SQLite test database collided. The signature is unmistakable --
assertion failures in files the mutation cannot reach.

Re-running that one case as an ad-hoc shell capture-and-restore was **denied**
by the classifier as irreversible local destruction (correctly: `$(cat f)` and
`printf '%s' "$O" > f` strips a trailing newline). I did not re-issue it another
way. The fix was to re-run the harness that already had the approval -- all ten
cases, 12 minutes, with nothing else touching the database. **M1-M9 came back
byte-identical across both runs, which is what makes M10's number trustworthy**:
only the last case was ever contended, and alone it is killed by exactly
`test_a_non_numeric_offset_is_rejected_not_a_crash`. The lesson is boring and
worth writing down: do not run pytest while pytest is running.

**Coverage decodes to four negatives and one piece of dead code.** Per-file
coverage finds five uncovered lines under `*/_tests/*`, a category the project
had not looked at:

- `test_api_auth_surface.py:114` is `reachable.append(...)` -- uncovered
  because **no API endpoint answers without a session**. The sweep is clean.
- `test_socket_path.py:86-87` is the `except ValueError` that explains an
  unrouted socket -- uncovered because `App.vue` and `chat/routing.py` agree.
- `test_socket_path.py:83` is `comm.future.result()`, the re-raise inside
  `if not connected` -- uncovered because the connection never fails.
- `test_entry_point.py:131` is `except UnicodeDecodeError` -- uncovered because
  `frontend/public/` holds no binary asset.
- `test_room_api.py:18` was **not** of that kind. `rooms_url` was a fixture
  nothing requested -- one occurrence repo-wide, the definition. Deleted, and
  the `import pytest` it orphaned went with it.

Three of those four are arms that exist precisely so that a failure is explained
rather than silent. Calling them gaps would be wrong.

Also measured and negative: `users/views.py` and `users/tests.py` are
`startproject` stubs (1 statement each, never imported -- `users` *is* wired as
`AUTH_USER_MODEL`), and the commented-out dead code across the project is 14
lines in `asgi.py`, 2 in `consumers.py`, 1 in `roomViews.py`. Not defects;
`asgi.py`'s are the three tutorial ASGI setups from the Channels walkthrough.

pytest **252** unchanged. jest **235** unchanged. **No production file
changed**, so **no bundle rebuild**. `messageViews.py` verified free of reversion
residue by re-checking all ten anchors after the sweep; the 39/30 `git diff`
against HEAD is prior work, not this item.

### 85. The largest Python file, and the one line item 35 explained by reading

`friends/models.py` is 676 lines and 335 statements. Item 35 decoded all six of
its uncovered lines (`418-419`, `536`, `565`, `642`, `675`), so sweeping *those*
would have been motion. This sweeps the covered, load-bearing paths instead --
above all the `are_friends` asymmetry that item 35 settled **by reading** and
never by measuring. Eleven cases, whole suite, item 84's harness.

| | killed by |
|---|---|
| **F1 `are_friends` reads the single reverse row** | **survived** |
| F2 `accept()` stops storing the reverse row | 8 tests |
| F3 `accept()` leaves the request row behind | 5, incl. `test_accepting_creates_the_friendship` |
| F4 `accept()` leaves a mutual request standing | `test_both_sent_lists_are_already_empty_after_a_cross_invite_accept` |
| F5 `accept()` does not bust the friends cache | `FriendshipModelTests` |
| F6 `remove_friend` only un-friends one direction | 3, incl. `test_removed_friends_disappear` |
| **F7 `remove_friend` fires no signal** | **survived** |
| F8 `reject()` leaves the sender's tab stale | `test_rejecting_drops_the_request_from_the_unrejected_list` |
| **F9 `cancel()` leaves both tabs stale** | **survived, then killed by one new test** |
| F10 a user can befriend themselves | `FriendshipModelTests` |
| **F11 `follows()` stops reading either cache** | **survived** (control) |

**F1 is item 35's finding, upgraded from reasoning to measurement.** Item 35
wrote that `are_friends`' single-direction query "is correct" because
`accept()` stores the pair in both orders. Flipping
`Friend.objects.get(to_user=user1, from_user=user2)` to the reverse direction
changed nothing across all 253 tests -- no test ever creates a one-row
friendship and then asks. What makes that safe is not a code path any test can
reach, it is **F2**, and F2 dies to eight. So the honest statement is stronger
and narrower than item 35's: the *writer* of the two-row invariant is pinned by
eight tests, and the *reader* that depends on it is pinned by none. A test
there would have to construct a state production never constructs. Measured
negative.

**F7 is a dead signal, and it is one of twelve.** `friendship_removed` is
declared (`friends/signals.py:9`), imported (`models.py:18`) and sent
(`models.py:409`) -- and has **no receiver anywhere in the project**. Tabulated
across the whole file:

| | count |
|---|---|
| signals declared in `friends/signals.py` | 16 |
| of those, sent from app code | 16 |
| **with a receiver** | **4** (`chat/signals.py:16,26,36,57` -- the four `friendship_request_*`) |
| with none | 12 |

Two of the twelve fire on **live** paths -- `friendship_request_viewed`
(`models.py:181`) and `friendship_removed` (`models.py:409`) -- and both reach
nothing. The other ten fire only from the Follow/Block managers, which item 80
recorded as having no caller and no route. This is that standing decision
restated with a number attached. Nothing to test: no listener means no
behaviour, so a test could only assert that the send still happens.

**F9 was the one real gap, and it is item 47's bug pointed the other way.**
`cancel()` busts the sender's and receiver's caches exactly as `reject()` does.
The only test that covered it asserted `FriendshipRequest.objects.count() == 0`
-- a direct query that never touches the cache -- so deleting both busts left
all 252 tests green. `test_rejecting_reaches_the_senders_list` says the reason
out loud in its own docstring: "it is the stale warm cache that fails this --
busting is what empties it", and it warms the cache first. `cancel()`'s test
never did. Closed by `test_cancelling_reaches_both_tabs`, which warms both tabs
before cancelling. Killed on re-run by exactly that test and nothing else.

**The defect I announced and then withdrew.** Mid-sweep I stated as fact that no
code path busts `rejected_requests`, and that `views.py` serves that tab -- so
the dismissed list would go stale for 300s. **That was wrong.** I grepped the
*bust call sites* and concluded from them, and missed that `bust_cache` is an
indirection: `BUST_CACHES["requests"]` (`models.py:58-66`) expands one call into
seven `delete_many` keys -- `requests`, `unread_requests`, `unread_request_count`,
`read_requests`, `rejected_requests`, `unrejected_requests`,
`unrejected_request_count`. The corrected measurement is a positive rather than a
defect: **every** key any reader uses appears in some bust, so there is no orphan
cache anywhere in this file. The lesson is the same one item 35 already paid for
-- read the indirection before concluding from the call site.

**F11 was planted as a control and behaved as item 35 predicted**: a pure cache
optimisation whose `else` branch answers identically, so nothing can fail.

pytest **252** -> **253**. jest **235** unchanged. **No production file
changed**, so **no bundle rebuild**; `friends/models.py` verified free of
reversion residue by re-checking all eleven anchors afterwards.

### 86. The last un-reverted backend surface, and thirteen cases with no survivors

`chat/consumers.py` is 41 lines and 17 statements; `chat/signals.py` is 70 lines
and 21 statements (both measured with `coverage.parser`, not counted by eye).
Between them they are the entire server end of the websocket. Item 82 swept the
client handler that consumes what these send, and item 85 tabulated which of the
sixteen signals have a receiver, but neither of these files had been reverted on
purpose. Thirteen cases, whole suite each, whole-tree restore verified.

| | killed by |
|---|---|
| C1 an anonymous socket is accepted | 3, incl. `test_anonymous_connections_are_refused` |
| C2 pushes go to a group nobody is in | **18** |
| C3 connect never joins the user's group | **17** |
| C4 a refused socket discards a group it never joined | `test_a_refused_socket_does_not_try_to_leave_a_group` |
| C5 every push arrives with its payload emptied | 5, incl. `test_deleting_a_room_pushes_the_room_id` |
| C6 `connect()` leaves `room_group_name` unset | `test_a_refused_socket_does_not_try_to_leave_a_group` |
| C7 `connect()` never accepts the handshake | **26** |
| C8 the refusal returns without closing | 3, same three as C1 |
| S1 an invitation is pushed to the sender | `test_sending_an_invitation_reaches_the_receiver` |
| S2 accepting tells only the accepter | 2, incl. `test_accepting_tells_the_sender_to_refetch_their_sent_list` |
| S3 accepting tells only the inviter | `test_the_accepter_is_told_to_refresh_their_sent_list` |
| S4 accepting creates the room but tells nobody | 2, incl. `test_accepting_tells_both_of_them_to_refetch_rooms` |
| S5 a rejection is pushed to the rejecter | 2, incl. `test_rejecting_does_not_notify_the_rejecter` |

**Thirteen of thirteen. No survivor, so there was nothing to fix on the emitting
side.** Items 83, 84 and 85 each produced at least one survivor between them;
this one produced none, and not because the code is simple -- it is because this
surface was swept once already and the tests around it were written from the
reversion outward. The two instruments that did it are in this tree:
`push_received_by`/`pushes_received_by` (`test_consumer.py:183-213`), which drive
a real socket through a real HTTP call, and `_RecordingChannelLayer`
(`test_friendship_api.py:369`), which exists because `chat.signals` resolves its
layer into a module global at import time.

**Two facts the sweep had to earn, because reading them is a trap.**

`disconnect()`'s guard is not boilerplate the base class already covers.
`AsyncWebsocketConsumer.websocket_disconnect`
(`channels/generic/websocket.py:243-249`) iterates `self.groups` and discards
from each -- but `groups` is a class attribute set to `[]` in `__init__`
(`:162-166`), and the only `group_add` in the whole library is on the **layer**
(`layers.py:363`), never on the consumer. Nothing appends to `self.groups`, so
that loop is inert and `ChatConsumer.disconnect` performs the only group cleanup
in the process. C4 proves it: relaxing the guard to `if True:` makes a refused
socket discard from `None`, and one test notices.

`self.room_group_name = None` on line 10 is load-bearing for the same reason, and
**not** through a swallowed exception -- which is what I predicted before running
it. Channels does not swallow it. `AsyncConsumer.__call__` (`consumer.py:63-65`)
catches `StopConsumer` and nothing else, so the `AttributeError` a refused socket
would raise inside `disconnect` propagates out and fails the test outright. C6 is
killed by the same single test as C4, which is the right answer for both, and it
corrects the prediction rather than the code.

**`close(code=4001)` is decorative, measured rather than argued.** C8 confirms
the comment at `consumers.py:15-16` -- drop the `close()` and all three refusal
tests fail, so without it the handshake does hang, as claimed. The *code* has no
reader anywhere: the frontend's only close handler is
`chatSocket.onclose = function() {...}` (`App.vue:73-75`), which takes no
argument and calls `reconnectWebSocket()`, and the backend's only other mention
of one is `disconnect(self, close_code)`, never read. So no reversion of `4001`
was run -- a control there could only say "no test mentions it", which the
reading already established, and there is no reader for it to disprove. Left as
it is: one literal, and it shows up in a browser's frame inspector.

**The one defect this turned up was a docstring describing code that no longer
exists.** `test_the_accepter_is_told_to_refresh_their_sent_list`'s docstring
said, in the present tense, "Only the inviter is pushed `update_sent`, though:
`friendship_request_accepted_callback` sends to `from_user` and nothing else" --
while the assertion fourteen lines below it requires **both** groups. Anyone
grepping `signals.py` for that sentence lands on a loop that sends to
`(from_user, to_user)` and has to work out which one to believe. Rewritten to the
past tense this file already uses elsewhere ("dropping either field here left all
166 tests green"), and it now records S3 as well: this is the only test that reads
the accepter's half of that loop, and the reversion died here and nowhere else.

pytest **253**, unchanged. jest **235** across 42 suites, unchanged. **No
production file changed** -- a docstring inside a test -- so **no bundle
rebuild**. Both targets verified free of reversion residue by re-checking every
mutated anchor afterwards.

### 87. The largest live file never reverted, and four answers nothing was asking for

`friends/api/views.py` is 158 lines and 78 statements -- the biggest file left
after item 86. Its test file is the densest in the repo
(`test_each_refusal_carries_its_own_reason` pins all three 400 bodies and their
three statuses; `test_cannot_read_a_request_you_are_not_a_party_to` and
`test_a_get_on_a_mutating_url_will_not_show_you_someone_elses_request` pin the
detail view's ownership filter), so the interesting cases were never the middle
of a handler but the **shape of each response**: which list a mutating endpoint
hands back, and whether anybody reads it.

| | killed by |
|---|---|
| V1 the friend list is always empty | 3 |
| V2 the friend list is serialised as one object | 4 |
| V3 the two hand-built refusals are swapped | `test_each_refusal_carries_its_own_reason` |
| V4 the validation refusal answers with a string | `test_each_refusal_carries_its_own_reason` |
| **V5 sending an invitation answers with the received list** | **survived, then killed by one new test** |
| V6 removing a friend 404s on success | 2 |
| V7 a rejected request can be accepted | `test_a_rejected_request_cannot_be_accepted` |
| **V8 accepting answers with the sent list** | **survived, then killed by one new test** |
| V9 rejecting reads the sender's side | 6 |
| **V10 rejecting answers with the sent list** | **survived, then killed by one new test** |
| V11 a rejected invitation can still be cancelled | `test_cannot_cancel_a_request_they_already_rejected` |
| **V12 cancelling answers with the received list** | **survived, then killed by one new test** |
| V13 the received list answers with the sent one | 10 |
| V14 the sent list answers with the received one | 6 |
| V15 the dismissed list answers with the live one | 4 |
| V16 anyone can read anyone's invitation | 2 |
| **V17 the detail body nests the other side** | **survived (control)** |

**The four survivors are one defect, not four.** All four mutating endpoints end
by delegating to a list view and the store then *replaces a whole tab* with the
response (`actions.js`): `addFriend` and `cancelFriendRequest` commit to
`SET_SENT_INVITATIONS`, `acceptFriendRequest` and `rejectFriendRequest` to
`SET_RECEIVED_INVITATIONS`. Nothing asserted that the server sends the tab the
client asked for, and nothing could:

- the server tests assert a **status code** -- `test_cancelling_removes_the_request`
  checks `== 200` and then queries the model, never the body;
- `action_contracts.spec.js:131-157` pins the URL *and* the commit name, but the
  axios stub supplies its own `response.data`, so from the client side the body's
  identity is a free variable.

So the client was correct about where it commits and the server was correct about
what it returns, and nothing in the repository connected the two ends. Swap any
one and the tab renders the other one's rows -- the invitation you just sent
appears nowhere; a cancelled invitation reappears in Sent while another vanishes
-- with no error on either side.

**Closed by four tests, one per endpoint, each killed by exactly its own
reversion.** The two list serializers are mirrors (`FriendshipSentRequestSerializer`
nests `to_user` and hides `from_user`; the received one is the other way round),
which gives a one-key discriminator, and `assert_fills(tab, body)` is it.

The detail that makes them work is a bystander. `accept()` deletes the row and
`cancel()` deletes the row, so on their own the correct answer and the swapped
answer are *both* `[]` -- an empty list is right by accident. Each test therefore
seeds a second request in the opposite direction (carol into alice, alice out to
dave) so both tabs stay non-empty and a swap has something to be wrong about.
Without that, V8 and V12 would still survive.

**V17 was planted and behaved as predicted.** The detail endpoint's body nests
`from_user`, and nothing reads it: `actions.js` POSTs to accept/reject/cancel and
GETs the two lists, and never fetches `/friends/requests/<id>`. `test_read_a_request_you_sent`
asserts `status_code == 200` and never opens `.data`. So the shape is unpinned
*and* unread -- a correct survival, and the fourth and last measured negative
here. The load-bearing half of that view, the ownership filter, is pinned by two
tests and V16 dies to both.

**V3 was a harness error, not a kill, and the fix is worth recording.** Swapping
two messages needs one *joint* anchor: applied as two edits, the first
replacement creates a second occurrence of the second anchor, and the
uniqueness assert -- correctly -- reads that as an error. It reported itself as
such rather than as a kill, was re-run with a single two-line anchor, and died to
`test_each_refusal_carries_its_own_reason`. Same class as item 84's lesson: a
broken case is not a surviving one.

pytest **253** -> **257**. jest **235** across 42 suites, unchanged. **No
production file changed** -- four tests -- so **no bundle rebuild**.
`views.py` verified free of reversion residue by re-checking all seventeen
anchors afterwards.

### 88. The models file, and a query that answers a weaker question

`djchat/chat/models.py` -- 139 lines, 67 statements, never reverted. Two of its
three model behaviours already had tests written *from* reversion
(`test_message_pending.py`'s header records that deleting both pending guards
left everything green), so this item is the check on whether that history was
complete. Sixteen cases: **13 killed, 3 survived**.

**M2 is a correct survival, and it is the reason this file was worth the
sweep.** `get_pending_messages` orders by `timestamp`, ascending. Flip it and
all 257 pass -- because the client re-sorts. `mergeMessages` in
`store/mutations.js` ends in `.sort((a, b) => position(a) - position(b))` where
`position` is the message id, so the server's ordering is discarded on arrival
regardless. `load_path.spec.js` pins all six arrival orders of the three
writers precisely because arrival order is unspecified. Nothing to fix; the
honest answer is that this atom has no server-side reader.

**M11 and M12 are the two real gaps, and they are one query.** `get_or_create_private`
(`models.py:112`) is asked for *the one private room for these two people*, and
its answer is the conjunction of two filters:

```python
        room = cls.objects \
            .filter(kind=cls.RoomKind.PRIVATE, participants=user_a) \
            .filter(participants=user_b) \
            .first()
```

Each filter alone is load-bearing and neither is covered.

**M11 -- drop `.filter(participants=user_b)`.** "The one private room for these
two" becomes "a private room of this person's, with anyone in it". So Carol, who
has been talking to Dave, accepts an invitation from Alice, and the room the
accept signal hands back is Carol's old one. The new friendship is created with
**no room joining the two of them**, and Alice's sidebar never gains a
conversation. `accept()` still answers 200 and still pushes `update_rooms` to
both sides, so the failure is silent -- it is visible only as a room that never
appears. The existing accept tests cannot see it because they all start from
users who have no private room at all;
`test_reinviting_after_a_removal_does_not_create_a_second_room` needs *both*
users to already share one, which is the opposite setup.

**M12 -- drop `kind=RoomKind.PRIVATE`.** The query answers "any room with both of
them in it", so a **group** the two of them share is served as their private
chat: the group, with everyone in it, under the name of a conversation between
two. `.first()` orders by pk, so the *older* room wins -- which is why the group
has to be created first in the test.

Both callers are live: `chat/signals.py:38` (the accept path) and
`chat/api/roomViews.py:316` (POST with kind=1).

**Closed with two tests, one per direction.**

- `test_accepting_never_lands_the_two_in_the_accepter_old_room` (friends) --
  seeds Carol a private room with Dave, has her accept from Alice, then asserts
  exactly one room joins the two of them, that it is not Carol's old one, that it
  contains only them, and that her Dave conversation is untouched.
- `test_a_private_chat_ignores_a_group_both_of_them_are_in` (chat) -- seeds a
  GROUP room with both users, then asks for a private chat with the other, and
  asserts `kind`, a different id, exactly the two participants, and 201.

Each dies to exactly its own reversion and to nothing else in 259:
M11 -> **1 failed, 258 passed**; M12 -> **1 failed, 258 passed**.

**One methodology finding, worth more than either test.** M12's first version
asserted `status_code == 201` first, and that is what fired -- `assert 200 ==
201`, a message that names status codes and sends you to the wrong place
entirely. Reordering so `kind` leads made it `assert 2 == 1`. When two
assertions both catch the same mutation, the one that names the defect belongs
first; the one that merely notices it is noise in front of the signal.

pytest **257** -> **259**. jest **235** across 42 suites, unchanged. **No
production file changed** -- two tests -- so **no bundle rebuild**.
`models.py` verified free of reversion residue by re-checking both mutation
shapes as exact strings (both absent, the correct form present once) rather than
by loose substring, which item 86's `group_general_user_None` false positive
showed is not safe here.

### 89. A re-sweep that dated a file, and the one line the sidebar dereferences

`chat/api/serializers.py` -- 94 lines, 58 statements, last swept by item 46,
which ran eleven mutations and tabulated all of them. This sweeps the atoms
that table does not name. Seventeen cases: **16 killed, 1 survived**.

**The lead was wrong, and the way it was wrong is the useful part.** I expected
`get_last_message`'s `order_by('-timestamp')` to survive. `User.vue`'s
`lastMessage` computed takes `roomMessages[length - 1]`, so the client does its
own ordering and ignores the server's id entirely -- and `/rooms/` ships exactly
*one* message per room, so there is nothing to re-sort and the server's ordering
is the only opinion in the process. That reasoning was sound and the conclusion
was wrong: **killed** by `test_recents_carries_the_last_message_of_each_room`,
which asserts `last_message == last.id` against a room holding two messages. I
had already read that test and talked myself past it. The sweep decided, not
the reading -- which is the entire reason to run one.

S10-S12 and S16-S17 were also predicted dead, and are: `CreateRoomSerializer` and
`CreateMessageSerializer` are covered by tests written *later* -- item 51's group
creation asserts the stored `group_name == 'Crew'`, and item 46 closed
`front_key` itself. So the gap in item 46's table was filled by other items
rather than never noticed. That is a **dating result**: the file has been fully
protected since item 46, and a second sweep is how you find that out.

**S9 survived: `get_group_name`'s group branch, `return obj.group_name`.**

The reason is structural. `get_group_name` and `get_group_profile` read the same
model field, but on **three different statements** -- `get_group_name` returns
it bare, `get_group_profile` returns it inside a dict. Item 46 covered the dict
one twice (reads `kind == 2`; a group's profile loses `username`/`tagline`) and
the private branch of `get_group_name` twice. The bare group return was in
nobody's table.

And every group test in the repo reads `group_profile`.
`test_group_room_profile_exposes_the_group_name` asserts the *whole dict*,
because a renamed key rendered the literal string "undefined" -- a real bug,
found once already. That care went into the dict's shape, and nobody asked what
the key next to it held.

**What it costs is a crash, not a blank label.** `User.vue:20` is

```js
{{ room.group_name.charAt(0).toUpperCase() }}
```

no guard and no `||`. `null.charAt(0)` is a TypeError, and one group member's
row is enough to fail the render for everyone in the list. `MessagesSection.vue`
dereferences the same field three times and guards it all three ways -- `:25` a
ternary, `:31` and `:329` `|| ""` -- which is precisely why reading this file
stopped at "the chat header has a fallback" and never asked who else reads it.
The guarded reader looked covered. Same asymmetry as item 87's four survivors,
in the other direction: there the *un*guarded one was the gap.

**No test on either side of the boundary could have caught it, and that is the
generalisable finding.** No jest suite can kill S9: the client tests stub
`group_name: 'Crew'` straight into a component and never touch the serializer.
No pytest test killed it either, because every test that looks at a group looks
at `group_profile`. The gap is only visible by following one field from the
Python method to the Vue template and asking what the template does when that
field is null. Coverage on both sides is 100% of the wrong things.

Closed by `test_a_group_room_carries_its_own_name`, which asserts
`room['group_name'] == 'Crew'` and dies to S9 alone:

```
R  get_group_name -> None for a group   1 failed, 259 passed
   djchat/chat/_tests/test_room_api.py::test_a_group_room_carries_its_own_name
```

**The production line is correct.** This is a test gap, not a code defect, and
the entry says so. Nothing in `serializers.py` was changed.

**The sweep queue is closed.** This was the last file in the repo with real
behaviour that had never been reverted on purpose. Every production Python file
over ~10 statements now has at least one reversion behind it:
`friends/models.py` (item 85), `chat/api/roomViews.py` (83),
`chat/api/messageViews.py` (84), `friends/api/views.py` (87),
`chat/models.py` (88), `chat/api/serializers.py` (46, re-swept here),
`users/api/views.py` (item 6, mutation-checked three ways),
`chat/signals.py` + `chat/consumers.py` (86), `friends/api/serializers.py`
(item 87's four tests die to its two mirror shapes). Everything below that is
declaration-only: `friends/signals.py` is seventeen `Signal()` objects with no
behaviour to break, `friends/admin.py` is registration, `manage.py` is Django
boilerplate. There is nothing left to revert on purpose, and the honest next
step is not another sweep.

**One harness flaw, now that it has cost something.** The per-case `print` has
no `flush=True`, so seventeen cases of stdout were block-buffered and the run
was opaque until it exited -- including a stretch where I was checking whether
the process was still alive rather than what it had already found. Items 86, 87
and 88's harnesses share it. One keyword, and it only bites on a long run, so
it is recorded rather than fixed: the queue is closed.

pytest **259** -> **260**. jest **235** across 42 suites, unchanged. **No
production file changed** -- one test -- so **no bundle rebuild**.
`serializers.py` verified free of residue by exact-string check (`return None`
count 0, `return obj.group_name` count 1, byte-identical to the pristine copy)
rather than by `git status`, which showed it `M` before this session began.

### 90. Every unguarded dereference, and why five of the six are not the gap

Item 89 found a gap no test on either side of the boundary could see: a
nullable field flowing from a Python method into a Vue template. That is a class
rather than an incident, so this measures whether it has more than one instance.
The method is mechanical -- `.charAt(` is the crash-shaped operation on a string
field, so every occurrence is a candidate, and there are six:

| site | guarded? | can the server send null? |
|---|---|---|
| `UserProfile.vue:163` | ternary | no -- own profile, `username` non-null |
| `ContactProfile.vue:261` | ternary | no, and `getGroupProfile` is `\|\| {}` |
| `UsersSection.vue:119` | ternary | no |
| `MessagesSection.vue:25` | ternary | no -- `currentRoom()` is `\|\| {}` |
| `UserInvitation.vue:16` | **no** | no -- see below |
| `User.vue:20` | **no** | **yes, and nothing pinned it** -- item 89 |

**Two sites are unguarded and only one of them is a gap.** `UserInvitation.vue:16`
is unguarded and safe: `FriendshipSentRequestSerializer` declares
`to_user = UserSerializer()` as a *field*, so the key is always emitted, and
`CustomUser` inherits `username` from `AbstractUser`, which is `unique=True` and
not nullable. No server path produces the bad state.

`User.vue:20` was unguarded and unsafe, because `get_group_name`'s group branch
returned a value no test asserted. **The difference between the two sites is not
the template -- it is whether the contract feeding it is pinned.** So the guard
was never the missing thing. A template guard on `User.vue:20` would have made
the symptom disappear while leaving the unpinned contract in place, which is
exactly the change that leaves the *next* edit unprotected. Item 89's test pins
the contract; the template is fine as it stands.

The other nullable Room fields are safe for the same reason. `last_message` is
null for an empty room and has **no client reader at all** -- the only mention in
`src/` is a comment in `mutations.js`. `group_profile.id` is null by design for
groups, and its one reader (`ContactProfile.vue:257`) guards with `|| {}`.
`group_name` cannot be null for a group because `roomViews.py:325` refuses a
blank one.

**One instance, found and closed.** No second instance exists, and this thread
does not need re-opening.

pytest **260**, unchanged -- this item changed no production code and no test,
which is what a negative should cost. jest **235** across 42 suites, unchanged.

### 91. The half-rename, which is a defect, and the coordinated one, which is not

Items 61, 62 and 65 deferred a refactor on one stated ground: a *coordinated*
rename of a contract field -- server, client and hand-written fixtures moved
together -- leaves everything green, and "only a single source of truth closes
that". This item measures the halves instead of re-reasoning the whole, and the
deferral is aimed at the wrong case.

All four rows below were run, on `group_profile`, against the whole suite:

| what moved | pytest | jest |
|---|---|---|
| producer only (the serializer) | 2 failed, 258 passed | **235 passed -- blind** |
| consumer only (`ContactProfile.vue`) | 1 failed, 260 passed -- *only the new test* | 2 failed (item 65) |
| both, fixtures stale | 3 failed, 258 passed | 2 failed |
| both, fixtures updated | not run -- see below | not run |

**A coordinated rename is not a defect.** Move the field everywhere it appears
and the code is correct; a test that went red would be a worse test. So the
refactor these three items kept reaching for is aimed at a non-failure, and rung
1 says it does not need to exist. The fourth row is the one I did not run, and
leaving it unrun is the honest result: both suites green is the *correct* answer
there, so there is nothing to measure.

**The half-rename is a defect, and nothing was watching it.** `group_profile` is
a `SerializerMethodField` -- no model column behind it, so renaming it is legal,
which is exactly why it is the field most likely to drift. Rename it on the
server and leave the client, and `ContactProfile.vue:257` reads a field the API
no longer sends: the avatar and heading of every group render blank.

The two pytest tests that go red are tests *of the serializer*. They report that
the server changed -- true, and not the same thing as reporting that the client
is now wrong. All 235 jest tests pass, because every fixture in them is
hand-written and none of them has heard from the server. That is not a stub
failing to be a good stub: a unit test with a fixture **cannot** detect a
producer change, by construction, and no assertion placed inside one ever will.
Item 65 closed the consumer half by asserting the header renders *from* the
field. Nothing had addressed the producer half, because the server's own tests
sit right there and look like coverage.

Closed by `test_every_room_field_the_client_reads_is_still_produced` -- the one
direction that is a defect. It walks `frontend/src/**/*.vue` for what is read
off a room (`getRoom.`, `currentRoom.`, `room.`) and asserts that set is a
subset of `RoomSerializer().fields`. Four names today -- `group_name`,
`group_profile`, `id`, `last_activity` -- and no false positives, which I
measured *before* writing the test rather than discovering afterwards.

- **Red** on the producer half-rename, with the client consequence in the
  message: `the client reads ['group_profile'] off a room and RoomSerializer no
  longer sends it. jest cannot see this...`
- **Green** on the coordinated rename. That is the point: it is one-directional
  by design and must not punish a correct change.
- Also red on the consumer-only rename, where item 65 is the only thing that
  catches it today. The two tests are complementary, not redundant.

Read from the source, not the built bundle, for the reason the cap tests above
give.

**What is left is correctly scoped, and it is small.** What no test can catch is
a rename that moves server, client and fixtures *together* -- and that change is
correct, so nothing should catch it. What this test adds is the guarantee that
was genuinely missing: the client cannot be left pointing at a field the server
stopped sending. That is the whole of the gap as it actually existed, and it was
one test rather than a refactor.

pytest **260** -> **261**. jest **235** across 42 suites, unchanged. **No
production file changed** -- one test. `ContactProfile.vue` and `serializers.py`
were edited only as the experiment above and restored byte-identically against a
pre-edit copy, so **no bundle rebuild**: the committed `static/dist/bundle.js`
was never stale.

### 92. The same seam on the other payload, measured rather than assumed

Item 91 closed the producer half-rename for `RoomSerializer` and concluded it
was "the whole of the gap as it actually existed". That was too quick, and this
item is the correction: the conclusion was about the one field that happened to
be renamed, not about the seam.

`MessageSerializer` has three method fields with **no model column behind them**
-- `is_owner`, `all_received`, `all_read` -- so they are exactly as legal to
rename as `group_profile` was, and the client reads all three (`MessagesSection`
and `User.vue` branch on `is_owner` to choose which bubble to render). Renaming
`is_owner` to `is_ownr`, declaration and method:

```
   pytest   2 failed, 258 passed   -- the serializer's own tests
   jest     235 passed             -- nothing
```

**Identical blindness, on a payload nobody had checked.** And it is worse than
`group_profile` was: `is_owner` is the switch between the left-aligned received
bubble and the right-aligned sent one, so a thread does not render blank, it
renders every message on the wrong side. This is the failure item 91 said did not
exist.

Closed by `test_every_message_field_the_client_reads_is_still_produced`, the
mirror of item 91's room test and following the file's existing mirror-pair idiom
(the two cap tests are a pair the same way). Both access patterns were measured
before either test was written: room reads four names, message reads seven.

**The one client-only field is named, not pattern-matched.** `sending` marks the
optimistic bubble between the POST and the server's copy -- `SEND_MESSAGE` puts
the front_key in `sendingPool`, and nothing in Django has ever heard of either.
It is subtracted before the comparison rather than allowed through a wildcard,
because a wildcard here would swallow the next real gap. Renaming `sending` is
not a seam, so it does not get one.

The two tests hold their contract in both directions, which is the only thing
that makes the first one trustworthy:

- **red** on `is_owner` alone -> `the client reads ['is_owner'] off a message and
  MessageSerializer no longer sends it, so the thread renders without it`
- **green** on serializer *and* both client sites renamed together, which is the
  correct change and must not be punished

**The other two payloads are clean, and that is a measurement.** The client reads
`invitation.id`, `invitation.to_user`, `invitation.from_user`, `user.id`,
`user.username` and `user.email`, all emitted by `FriendshipRequestSerializer`,
`FriendshipSentRequestSerializer` and `UserSerializer`. No test is added for
them, because a test with no demonstrated failure behind it is not protection,
it is ceremony. If one of those is renamed, the same fix applies then.

So the correct statement of item 91 is narrower than the one it made: the seam
was real and is now closed for **both** stored payloads. The refactor those items
kept deferring is still unnecessary -- a coordinated rename is a correct change
and stays green on purpose.

pytest **261** -> **262**. jest **235** across 42 suites, unchanged. **No
production file changed** -- one test. `serializers.py`, `MessagesSection.vue` and
`User.vue` were edited only as the experiment and restored byte-identically
against pre-edit copies, so **no bundle rebuild**.

### 93. The deferral in item 92 was wrong, and the fix is smaller than the test it replaced

Item 92 deferred the user and invitation payloads because they were "clean", and
the word it used for clean was *no test went red*. That is the same blindness
items 91 and 92 measured, wearing the costume of a clean bill of health. So this
item measured them properly instead of taking the deferral's word for it, and the
deferral did not survive.

**Four mutations, two payloads, both blind to jest:**

| mutation | legal? | pytest | jest | what the user sees |
|---|---|---|---|---|
| `users.UserSerializer.tagline` -> `taglne` | **no** | error | 235 pass | -- |
| `users.UserSerializer`: drop `tagline` | yes | 52 fail | **235 pass** | description line blank |
| `friends.UserSerializer`: `username` -> `uname` | yes | 27 fail | ? | avatar renders `undefined` |
| `FriendshipSentRequestSerializer`: `to_user` -> `t_user` | yes | 15 fail | **235 pass** | sent invitations lose their person |

The first row is the one worth keeping. Renaming a field that **has a model
column behind it** is not a rename at all -- DRF refuses it outright with
`ImproperlyConfigured: Field name 'taglne' is not valid for model 'CustomUser'`.
Item 91's whole argument rests on the method fields being *legally* renameable,
and that argument does not transfer. So the honest mutation for this payload is
not a rename at all, it is a **removal** -- and a removal is legal, silent, and
takes `ContactProfile.vue:268` (`this.getGroupProfile.tagline`) from a sentence
to an empty string. Measured: pytest red on 52, jest green on all 235.

**What was already protected, and I nearly added a test for it.** The two
friends-app mutations are caught by pytest -- 27 and 15 failures, in
`test_friendship_api.py` and `test_reinvite_after_reject.py`. Those suites pin the
narrower `friends.api.serializers.UserSerializer` (`id, username, email`, no
`tagline`) and the invitation envelope already. Adding a seam test there would
have been ceremony with a measurement behind it, which is still ceremony. The
`invite` receiver is therefore deliberately absent from the new test, and the
comment says which suite is doing the work instead.

**The fix is smaller than what it replaced.** Items 91 and 92 left two copies of
the same twelve-line loop, differing only in a regex and a serializer class. A
third copy for a third payload is how a seam test rots, so the two are collapsed
into one loop over three `(serializer, receivers, client-only fields)` rows --
shorter than either original, and adding a fourth payload is a line rather than a
thirteenth copy.

**Two corrections I owe, both found by running rather than reading.**

1. *The reader pattern needs no word boundary, and pretending otherwise would
   have been wrong.* I reached for `(?<![\w.])` to stop `invitation.to_user` being
   read as a `user.` receiver. The comment in the test explains why it is not
   there: `this.` is a preceding dot, so the lookbehind would reject the receiver
   of every `this.room.` in the codebase and the room row would match nothing.
   The two payloads overlap in the source and the comparison is a subset test
   against the *widest* serializer, which is the one that actually feeds
   `getGroupProfile`, `message.author` and the current-user profile. Measured, not
   argued: the user receiver set is exactly `{email, id, tagline, username}` and
   `UserSerializer` emits exactly those four.
2. *My own harness lied about S2.* The first batch run reported the `is_owner`
   mutation killed by the **room** seam, with a message identical to the
   `group_profile` run. It was not a lie by the test but by the harness: the
   message filter was `grep 'no longer sends'`, and pytest's `--tb=line` prints
   the *source line* of the assert, which contains those literal words and is the
   same text for every row. Fixed by filtering on the interpolated `E` lines
   instead. S2 in fact dies on `is_owner off a MessageSerializer`, and S1 on
   `group_profile off a RoomSerializer` -- each on its own row, which is the only
   result that means anything for a table like this.

**Reversions, each required to kill its own payload:**

| reversion | killed by | message |
|---|---|---|
| `group_profile` -> `group_rofile` | room row | `reads ['group_profile'] off a RoomSerializer` |
| `is_owner` -> `is_ownr` | message row | `reads ['is_owner'] off a MessageSerializer` |
| drop `tagline` from `fields` | user row | `reads ['tagline'] off a UserSerializer` |

pytest **262** -> **261** (two tests became one), still fully green. jest **235**
across 42 suites, unchanged. **No production file changed** -- one test file, and
the three mutations above were reverted byte-identically against pre-edit copies,
so **no bundle rebuild**. `users/api/serializers.py` and
`friends/api/serializers.py` are the only files that were ever written to and both
were restored; the invite-user `username` -> `uname` row above was measured and
not written into the plan's "what changed" because it needs no test.

## Proposed next, and what was measured

Asked for as "Phase 2 enhancements", which is the name of the section items
1-50 already live in - so this is that section's backlog rather than a new
phase. The two cheapest entries are done (items 49 and 50); the rest is
written down with the cost attached, because the next one is a design decision
and not a wire-up.

Three of the four were found the same way - by grepping the tree for callers of
an endpoint that exists - so the list is short because the codebase is short,
not because it was cut short. Each entry says what it would cost, and the two
cheapest ones are cheap for the same reason: the backend half is already done
and tested.

**1. Wire the export endpoint to the UI** - **done**, item 49 above.

**2. `Menu.vue` has no keyboard path, and it holds the only Logout** -
**done**, item 50 above.

**3. `POST /api/v1/rooms/` - group creation - exists and is unreachable** -
**done**, item 51 above. The open question in the original entry - who may be in
a group - was answered: people you already chat with, because no user-list
endpoint exists to offer anyone else, and building one would have been a larger
change than the feature.

**4. `GET /api/v1/friends` has no caller** - and I am not proposing it. The
friend list is already on screen: every private room carries the peer's
`group_profile`, which is what the sidebar renders. Adding a second source of
truth for the same list is the opposite of the ladder. Recorded as measured and
declined, not as a gap.

**Data visualisation: nothing to propose.** Item 4 already built it - the
30-day activity chart, `RoomActivityAPIView` -> `ContactProfile`'s SVG,
`role="img"` with an `aria-label`, zero-filled and in order so the bars cannot
silently misalign. A second chart on this data would be decoration.

**Housekeeping, zero risk:** `components/Example.vue` is dead - the entire
template is commented out and nothing imports it. Left in place; it is one file
and deleting it is your call, not a defect.

### Phase 2, proposed after the survey came back empty

Asked for as "data visualizations, UI polish, export features". Two of those three
are already built and I am not rebuilding them:

- **Export** - item 49. Both formats, `ContactProfile.vue:200`,
  `room_export_links.spec.js`.
- **Data visualisation** - item 4. The 30-day SVG activity chart off
  `RoomActivityAPIView`. A second chart on the same data is decoration.
- **The items 1-3 survey is now empty.** No dangling endpoints remain, and I
  nearly filed three false gaps before reading the code. A literal
  `dispatch("name")` grep reported accept/reject/cancel as uncalled, but
  `Invitations.vue` passes the action name as a *variable* to `actOnInvitation`;
  an `export` grep missed the export URL, which is built in a computed. Typing
  indicators are wired end to end (`postWriting` -> `RoomWritingAPIView` ->
  `App.vue:62` -> EventBus -> "X is writing..."). Worth writing down: the method
  found items 1-3 by finding things with no caller, and it now finds only its own
  blind spot.

**Done: multi-line composition** - item 75 above. The one real gap.

**1. Message search in a room** - **done**, item 76 above. The server half was the
reason it was second on the list and not first: `LastMessagesRoomAPIView` takes
the newest **ten** and the store holds only those plus whatever you have paged
in, so a client-side search would answer "no such message" for every message
outside those ten. A `?search=` parameter on the existing view turned out to be
three lines, and it composes with `?offset=` for free. The two things a search box
usually gets wrong were both pinned: results in their own store map, and
`encodeURIComponent` on the term.

**2. Day separators in the thread** - **done**, item 77 above. One computed over
the flat `roomMessages` array, one nested `v-for`, `dateformat` doing the label it
already does elsewhere in the file. The filed cost was that the inner `:key` is
load-bearing for items 71-73; item 77's reversions say it is not, and says why in
three measured lines.

**3. Dark mode** - your call, and I am not proposing the work. It is CSS over
every component, and this Tailwind build is purged, so a dark palette means
touching every template's classes rather than adding a sheet. Declined here as
decoration until someone asks for it twice.

**Not proposed: a second source of truth for the sidebar.** The rooms list is the
friend list (`RoomSerializer`'s `group_profile` is what the sidebar renders), so
`GET /api/v1/friends` staying callerless is item 4's answer all over again.

## The build

`djchat/static/dist/bundle.js` is a **committed build artifact**, and it is the
file `templates/index.html` actually loads. There was no `node_modules` in the
tree at all, and both `npm run build` and `npm run serve` used Windows cmd
syntax:

```
set "NODE_OPTIONS=--openssl-legacy-provider" && vue-cli-service build
```

On Linux that `set` assigns `$1` and exports nothing (verified:
`NODE_OPTIONS=[]`), so webpack 4 ran without `--openssl-legacy-provider` and
would have died on OpenSSL 3. Now `cross-env`, and the build runs.

**The consequence was the real bug:** the shipped bundle still carried
`onclose=function(){}` and a hardcoded `wss://` - items 2 and 4 were
source-only, so the app everyone ran had neither. Rebuilt and verified in the
artifact: `retryDelay`, `reconnectWebSocket`, `"https:"===window.location.protocol?"wss://":"ws://"`,
`fetchRoomActivity`, `SET_ROOM_ACTIVITY`, `viewBox`. The `onclose=function(){}`
count is 0. The stylesheet lost no classes - 0 removed, 1 added (`activity`).

`npm run lint` now runs and exits 0. **It also rewrites files.** `vue-cli-service
lint` passes `--fix` by default, so the 50 pre-existing prettier warnings this
project carried were not warnings that got reported - they got *fixed*, in
place, in files nobody was working on: `MessagesSection.vue`, `ContactProfile.vue`,
`csrf_token.js`, `backend/index.js`. The reformatting is semantically inert, but
it means several diffs in this branch are much larger than the change they
contain, and the earlier note in this section ("50 pre-existing prettier
warnings") described a state that no longer exists. Nothing in it is a
functional change; a reviewer reading those hunks should know why they are there.

If that noise is unwanted, `npm run lint -- --no-fix` reports without writing,
and the formatting can be reverted on its own - but not as part of a fix, since
it would bury the real hunks.

**Closed in item 36, at your decision.** The start command in `problems.txt` never
built the frontend, so every one of those fixes was a source edit that silently
did nothing until someone ran `npm run build` and committed `dist/` again. You
chose to add the build to the deploy, so there is now `deploy.sh` - it runs
`npm ci && npm run build` before serving, and
`core/_tests/test_deploy_script.py` pins that the build precedes the serve line.

The residual gap, which no script can close: the build runs when you *deploy*.
Starting daphne by hand still serves whatever is in `static/dist/`, which is why
`core/_tests/test_entry_point.py` walks that directory for scratch pages instead
of trusting `frontend/public/` to be the whole story.

## Verification gap

`npm run test:unit` now exists - `@vue/cli-plugin-unit-jest` and
`@vue/test-utils`, the companion to the `@vue/cli-service` 4 already in the
tree, so there is still only one toolchain. It covers the two frontend
behaviours pytest cannot see:

- `tests/unit/websocket_reconnect.spec.js` - a closed socket is retried, the
  wait doubles and stops at 30s, a successful open resets it, the scheme
  follows the page protocol, the socket is connected before - and regardless of
  - the seven load fetches and exactly once, one failing load fetch leaves the
  other six issued, a hanging one cannot hold them, and a push that arrives when
  one of its own refreshes fails still renders and still rejects nowhere (items
  2, 16, 17 and 20). `onclose` back to an empty function fails it.
- `tests/unit/room_activity_chart.spec.js` - one bar per day scaled against the
  peak, a viewBox as wide as the series, the previous room's chart not drawn
  under the new room, and an empty room getting the empty state.
- `tests/unit/profile_save.spec.js` - a rejected save says so, in red, and
  re-enables the button; the tagline textarea is capped at what the server
  accepts.
- `tests/unit/room_message_order.spec.js` - the store's message ordering, its
  dedupe key, the room-with-no-messages crash, and the 'seen' key a sent message
  used to leave behind (items 9 and 13).
- `tests/unit/failed_send.spec.js` - a refused send comes off its clock icon,
  the delivered-anyway message can still arrive, and your text is not lost
  (item 10).
- `tests/unit/closed_room.spec.js` - no chat open means no history fetch, from
  either caller, and an open chat still pages (item 11).
- `tests/unit/room_paging_race.spec.js` - a page of history that lands after you
  have moved on does not cap the chat you are reading (item 12).
- `tests/unit/invitation_modal.spec.js` - an unreachable server produces a
  message instead of a `TypeError` inside the catch, the specific 404 and 400
  wording survives the fix, and a failed send leaves the dialog open (item 18).
- `tests/unit/contact_profile_delete.spec.js` - a failed "Delete chat" says so
  and leaves the panel open, a successful one still closes it and clears the
  selection, and a retry clears the stale message (item 19).
- `tests/unit/email_lookup_encoding.spec.js` - a plus in an email is encoded
  rather than sent as a space, and an ordinary address is left intact by the
  encoding (item 21). The server half - that Django decodes `%2B` back to the
  stored address - is `test_lookup_by_plus_addressed_email_returns_the_user` in
  `users/_tests/test_profile_api.py`.
- `tests/unit/user_writing_listener.spec.js` - a typing indicator for a user
  the store has not loaded yet does not throw, a known one still shows the
  name, a push for another room is ignored, and a destroyed row unsubscribes
  (item 22). `$off` back to a no-op fails the last one.
- `tests/unit/invitation_modal_stale_error.spec.js` - an error from one attempt
  does not outlive it, a second failure replaces the first message, `open()`
  clears what an earlier attempt left, a sent address does not come back, and
  `close()` still preserves a half-typed one (item 24). Removing any one of the
  three resets fails exactly one test.
- `tests/unit/contact_profile_stale_error.spec.js` - a delete refused on Bob's
  chat is not reported on Carol's, a failure on the *new* chat is still reported,
  and a `SET_ROOMS` refresh of the same room does not take the message down
  mid-attempt (item 25). The last one is what separates the watcher being on
  `roomId` from being on `getRoom`; it needs `Vue.observable` on the mock state,
  because the whole defect is a *change* to `selectedRoom` and a plain object
  would never fire a watcher at all.
- `tests/unit/send_form_draft_room_change.spec.js` - a draft typed for one chat
  is not sent to another, a refusal that lands after you switched chats does not
  reappear in the new chat's box, and a refusal in the *same* chat still puts the
  text back (item 27). The first is the misdelivery; the second and third pin the
  catch's room comparison from both sides, which `failed_send.spec.js` cannot do
  because it never changes `selectedRoom`.
- `tests/unit/send_form_maxlength.spec.js` - the input carries a cap, bound to
  the component's own constant, and a body at that length still sends (item 28).
  Its Django half, `test_the_client_cap_matches_the_body_limit` in
  `chat/_tests/test_message_api.py`, is the only thing that catches the two
  copies of the number drifting apart: under an off-by-one both jest tests pass.
- `tests/unit/invitations_refusal.spec.js` - all three actions report a refusal
  and resolve, all three say nothing on success, and a later success clears an
  earlier failure (item 29). The `resolves` half is load-bearing rather than
  decorative: pre-fix the un-awaited rejection killed the Node runner, so the
  spec did not fail so much as abort, and there was no way to tell "the message
  is not rendered" from "the process died".

The one gap in this whole run that no test reached, and it was a real one: the
`test.each` over the three actions in that spec means a fourth action added to
`Invitations.vue` later would be covered by nothing, and a typo in its dispatch
name would show up only as an invitation that never updates. The table is the
contract, not the component. **Closed in item 37** - the spec now reads the
component's template and fails if the two disagree.

Item 30 is the same gap biting in reverse, and it is the reason that one is
recorded as a gap rather than a rule. Two suites built a 400 with **no response
body** - a response this server never sends, because every one of its 400s
carries `detail` - and so asserted against the modal's own hardcoded sentence. A
green suite was pinning an unreachable response, which is worse than no test:
it read as coverage of the error path and covered nothing. `statusFromServer`
now takes a body, and the strings it passes are the ones
`test_each_refusal_carries_its_own_reason` pins on the Django side - so the two
halves cannot drift without one going red, which matters more now that a client
renders a string the server wrote.

On the Django side, `chat/_tests/test_tutorial_route.py` (item 23) - an
anonymous visitor at `/chat/` is sent to `accounts/login/`, and a signed-in one
gets byte-for-byte what `/` gives them, so the path is an ordinary SPA route and
the Channels tutorial page is gone. Restoring the route fails the second;
restoring it *with* `LoginRequiredMixin` fails only the second, which is what
makes the first a separate claim rather than a restatement. And two tests in
`core/_tests/test_entry_point.py` (item 26) walk `frontend/public/` and
`static/dist/` for a page that opens a socket at a local address, which is the
only way a development scratch file reaches production here - the bundle's
`public/` copy list and WhiteNoise's finders, neither of which the tests that
read `bundle.js` or the page's own asset URLs can see.

One hundred and twenty-one reversions of the code they pin each fail the intended test
rather than a parse error. `/* eslint-env jest */` sits in each file: an `overrides` block in
`.eslintrc.js` would be tidier, and the config-protection hook rightly blocks
weakening it.

Still open: rendering is only covered where it carries logic. Backend contracts
reached *through* the frontend are pinned by hand on the Django side, in
`test_consumer.py` and the API suites, and that is where most of this codebase's
risk actually lives. Item 42 is the first recorded instance where that pinning
was **not** enough - a contract each half kept to itself and nobody compared -
so the sentence is now a claim with a known counterexample rather than a summary.

Item 56 adds the other half of that sentence, and it cuts the other way. Every
mutation sweep above was measured over executed lines only, so never-executed
code "survived" trivially and the survivor counts could not have seen it.
Coverage, asked afterwards, found exactly three such statements in the whole
application - all three the *safe* kind, an inert delegation that mutates
nothing and inherits an ownership filter - and they are now pinned and at 100%.
The residual 26 uncovered statements are named individually there; all but two
are `__str__` methods, unreached branches, or vendored tutorial scaffolding.
The two exceptions were self-follow and self-block `ValidationError` guards,
and item 57 has since measured them: the whole Follow/Block axis is
unreachable - no view, no URL, no frontend, nothing in the bundle, and git
history showing the endpoint never existed. Their managers are already tested
for the same rule, so they are closed as recorded-and-declined rather than
covered.

The class is no longer hypothetical, and four of its instances are closed rather
than merely counted: item 52 (`kind`, request side), item 53 (`room_id` and
`days`, response side), item 54 (`sendMessage`'s three keys - the one that
silently loses the user's text) and item 55 (`patchUserProfile`, where the pin
that looked like it closed the seam was pinned against the client's own test).

**The sweep the plan listed is finished, and it finished mostly in negatives.**
Item 55 also measured the two candidates it did not close: `/me`'s response `id`
is killed by four tests, and every push payload in `test_consumer.py` is asserted
by exact dict equality, so there is nothing there to pin. Both are recorded above
rather than left as a guess.

What is still open is a shape of problem none of these items reached: a
**coordinated** rename now dies on every seam swept, but only because each was
individually pinned. A rename that moved the client, its spec, the serializer and
the test together would leave all of it green, and no amount of reading one file
from another prevents that - only a single source of truth does, which is a
refactor of these endpoints rather than a test.

**That paragraph was a claim until item 61 ran it, and it is now a measurement.**
Renamed `group_profile` - a `SerializerMethodField`, the one field with no model
column behind it, so the rename is legal - across the client, its three specs, the
serializer and the Django test, 14 places in 6 files: **244 passed, 134 passed.**
Renaming the producer alone is caught, so the green is a coordinated-rename result
rather than blindness. The client half is not: renaming the consumer alone also
stays green, because those three specs mention the field only inside mock
fixtures, so no rename of what the server actually sends can reach them. That
gap is closed for rendering by item 62 and is otherwise still open, and the fix is
the refactor this paragraph already names - a single source of truth for the
contract, which is not a test.

**Half of that last sentence was wrong, and item 65 is the correction.** "The
consumer half is still open" was measured, not reasoned: the three specs *mount*
`ContactProfile`, so `ContactProfile.vue:257` really does run under them - nothing
simply failed to execute. They just never asserted anything it produced, because
they were covering delete failures and stale messages and hit this line on the way
past. So the client half is closable by a test after all, and item 65 closes it:
assert that the header renders *from the field*, which is precisely what a
consumer-only rename breaks. What is still true, and still not a test, is the
*coordinated* rename - server, client and hand-written fixtures moved together
leaves everything green, and only a shared source of truth closes that. The
refactor is still the answer to that half.

## Deliberately not doing

- **Bulk export / delete all my data** - single room covers the need; the
  bulk version is the same code with a wider blast radius.
- **The read/unread request axis** - five manager methods and the `viewed`
  column, none of which any view, signal or serializer reaches. Measured, not
  assumed, in "The read/unread axis" below, so the decision is one line when you
  want to make it.
- **Dropping `viewed` from the database** - that part is a migration against a
  deployed database, which is your call and not mine to make silently.

## The read/unread axis

`friends/models.py` is vendored library code - `django-friends` is not in
`requirements.txt`, and the whole app appeared in the initial commit already
trimmed. So its manager is the upstream public API, and "unused" here means the
*fork* never adopted it, not that upstream got it wrong.

Grepping every reference in the tree (no Python, JS or Vue caller outside tests)
gives five dead methods, not the four this file previously claimed:

| method | line | production callers |
|---|---|---|
| `unread_requests` | 238 | none |
| `unread_request_count` | 255 | none |
| `read_requests` | 271 | none |
| `unrejected_requests` | 305 | none |
| `unrejected_request_count` | 322 | none |

Two further findings that change the shape of the decision:

- **`unrejected_requests` (305) is a byte-for-byte duplicate of `requests`
  (204).** Same `select_related`, same
  `filter(to_user=user, rejected__isnull=True)`, same list-into-cache shape -
  only the cache key differs (`frur-%s` vs `fr-%s`). That is not a feature, it
  is a copy, and it is the one item in the axis with an unambiguous answer.
- **`mark_viewed` (177) is dead too**, which means `viewed` has **no production
  writer at all** - the only production write is `add_friend` nulling it at
  364. The three tab endpoints use `requests()` / `sent_requests()` /
  `rejected_requests()`, none of which filter on `viewed`. So the axis is not
  "a badge nobody displays"; the state it tracks is never recorded.

The three tab endpoints do work. `GET /friends/requests/received` returns every
unrejected request regardless of `viewed`, so invitations show correctly. This
is dead weight, not a defect - which is why nothing is filed as a bug and why
the fix is yours to authorise rather than mine to assume.

The cost of leaving it: 14 assertions across two test files pin behaviour
nothing uses, so they read as coverage of a feature that exists. The cost of
removing it: a migration dropping a column on a deployed database. 14 assertions
can go with the methods; the column cannot go quietly.
