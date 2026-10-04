/* eslint-env jest */
/**
 * The order messages end up in inside a room.
 *
 * The bug this pins: two endpoints feed the same array, in the wrong order.
 * `GET /rooms/` ships each room's *newest* message (RoomSerializer's
 * `last_message`), and `GET /messages/` ships the older pending ones. Both
 * commit LINK_MESSAGES_TO_ROOM, which appended blindly -- so on every single app
 * load the newest message went in first and the chat rendered oldest-last: the
 * newest message sat at the top of the thread, with the older ones below it,
 * and scrollToBottom() parked the reader on a stale message.
 *
 * This file drives the mutation in one fixed sequence because that is the
 * clearest way to pin the *mutation*. The order the app actually sees is
 * unspecified -- `App.vue:114` runs all seven load fetches in one `Promise.all`,
 * so either endpoint can answer first -- and `load_path.spec.js` is what pins
 * the action layer under all six arrival orders, including the reverse of this
 * one.
 *
 * Id is the sort key: it is monotonic, it is what both endpoints paginate on
 * (`id__lt=offset`), and it is the only field both payloads are guaranteed to
 * carry.
 */
import mutations from "@/store/mutations.js";

const msg = (id, room = 7) => ({
  id,
  room,
  body: `m${id}`,
  front_key: `key-${id}`
});

function freshState() {
  return {
    rooms: {},
    users: {},
    roomMessages: {},
    receivedMessages: {},
    sendingPool: new Map()
  };
}

function link(state, messages) {
  mutations.LINK_MESSAGES_TO_ROOM(state, messages);
}

function linkPast(state, roomId, pastMessages) {
  mutations.LINK_PAST_MESSAGES_TO_ROOM(state, { pastMessages, roomId });
}

test("the newest message does not go above the older ones", () => {
  // Exactly what App.vue does on load: /rooms/ first, then /messages/.
  const state = freshState();
  link(state, [msg(5)]);
  link(state, [msg(1), msg(2), msg(3), msg(4)]);

  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, 2, 3, 4, 5]);
});

test("a message that arrives again is not shown twice", () => {
  // The store is written from four endpoints in created() plus every push, so
  // the same message is linked more than once in a session.
  const state = freshState();
  link(state, [msg(1), msg(2)]);
  link(state, [msg(2), msg(3)]);

  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, 2, 3]);
});

test("older messages go above the newer ones, in order", () => {
  const state = freshState();
  link(state, [msg(9)]);
  linkPast(state, 7, [msg(7), msg(8)]);

  expect(state.roomMessages[7].map(m => m.id)).toEqual([7, 8, 9]);
});

test("opening a room that has no messages yet does not throw", () => {
  // A room with no messages is never put in roomMessages at all -- /rooms/ only
  // carries a last_message, and there is none. Opening one dispatches
  // fetchPastMessages, which commits LINK_PAST_MESSAGES_TO_ROOM against an
  // undefined array: `...undefined` is a TypeError. MessagesSection catches it,
  // so it was invisible -- the chat just never learned it had reached the start.
  const state = freshState();
  expect(state.roomMessages[7]).toBeUndefined();

  expect(() => linkPast(state, 7, [])).not.toThrow();
  expect(state.roomMessages[7]).toEqual([]);
});

test("messages land in the room they name, not the room they arrive in", () => {
  const state = freshState();
  link(state, [msg(1, 7), msg(1, 8)]);

  expect(Object.keys(state.roomMessages).sort()).toEqual(["7", "8"]);
  expect(state.roomMessages[7].map(m => m.room)).toEqual([7]);
  expect(state.roomMessages[8].map(m => m.room)).toEqual([8]);
});

test("a message you are still sending keeps its place and gains its id", () => {
  // SendForm commits LINK_MESSAGES_TO_ROOM first, then ADD_MESSAGE_TO_SENDING,
  // so the optimistic message is already in the array before the server answers.
  // It arrives with no `id` -- only a front_key -- and the sendingPool branch
  // merges the server's copy into that same object.
  const state = freshState();
  link(state, [msg(1)]);
  const pending = {
    room: 7,
    body: "typed",
    is_owner: true,
    sending: true,
    front_key: "key-2"
  };
  link(state, [pending]);
  state.sendingPool.set(pending.front_key, pending);

  link(state, [{ id: 2, room: 7, body: "typed", front_key: "key-2" }]);

  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, 2]);
  expect(state.roomMessages[7][1].sending).toBeUndefined();
  expect(state.sendingPool.has("key-2")).toBe(false);
});

test("a message you sent does not leave a 'seen' key behind forever", () => {
  // `SendForm` commits LINK_MESSAGES_TO_ROOM *before* ADD_MESSAGE_TO_SENDING, so
  // the optimistic message misses the sendingPool branch and registers its
  // front_key in `receivedMessages` -- a set nothing ever pruned. Every message
  // a user sends therefore left one entry there for the rest of the session,
  // reactive and permanent, describing a message that had long since arrived.
  //
  // The sendingPool branch is the point at which a message stops being in
  // flight: the server's copy has landed and been merged onto the same object.
  // That is where the key should go, and nothing else has to make that call.
  const state = freshState();
  link(state, [msg(1)]);
  const pending = {
    room: 7,
    body: "typed",
    is_owner: true,
    sending: true,
    front_key: "key-2"
  };
  link(state, [pending]);
  state.sendingPool.set(pending.front_key, pending);
  expect("key-2" in state.receivedMessages).toBe(true); // the hazard, set up

  link(state, [{ id: 2, room: 7, body: "typed", front_key: "key-2" }]);

  expect("key-2" in state.receivedMessages).toBe(false);
  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, 2]);
});

test("pruning that key does not let the message back in twice", () => {
  // The reason it is safe to drop. A sender's own copy comes back exactly once
  // -- `MessageViewSet.list` runs `get_pending_messages`, which takes the reader
  // out of pending -- but two overlapping fetches can both list it before either
  // clears it. With the key pruned, the second arrival now reaches the ordinary
  // path instead of being filtered out, and `mergeMessages` dedupes on
  // front_key. One bubble either way.
  const state = freshState();
  link(state, [msg(1)]);
  const pending = {
    room: 7,
    body: "typed",
    is_owner: true,
    sending: true,
    front_key: "key-2"
  };
  link(state, [pending]);
  state.sendingPool.set(pending.front_key, pending);
  const confirmed = { id: 2, room: 7, body: "typed", front_key: "key-2" };
  link(state, [confirmed]);

  link(state, [confirmed]);

  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, 2]);
});

test("two messages typed before either is confirmed both stay", () => {
  // Both have `id` undefined until the server answers. A merge that deduped on
  // id -- the obvious key, since id is what sorts -- would collapse them into
  // one and silently eat a message the user just sent.
  const state = freshState();
  link(state, [msg(1)]);
  link(state, [
    { room: 7, body: "first", sending: true, front_key: "key-2" },
    { room: 7, body: "second", sending: true, front_key: "key-3" }
  ]);

  expect(state.roomMessages[7].map(m => m.front_key)).toEqual([
    "key-1",
    "key-2",
    "key-3"
  ]);
});

test("a message still in flight sorts below a page of history landing on it", () => {
  // The other way an unconfirmed message meets `position`, and the one the
  // guard above exists for. `Infinity` is what keeps an in-flight message at
  // the bottom; drop the `undefined` arm and it is `undefined - 7` = NaN, and
  // a comparator returning NaN leaves the array as it was -- so the message you
  // are typing renders ABOVE the history you just scrolled up to read.
  //
  // Reachable because `SendForm` links the optimistic message before the server
  // has answered, and `fetchPastMessages` merges into whatever is already in the
  // room. Type a message and scroll up while it is still in flight.
  const state = freshState();
  link(state, [msg(9)]);
  const pending = { room: 7, body: "typed", sending: true, front_key: "key-2" };
  link(state, [pending]);
  state.sendingPool.set(pending.front_key, pending);

  linkPast(state, 7, [msg(7), msg(8)]);

  expect(state.roomMessages[7].map(m => m.front_key)).toEqual([
    "key-7",
    "key-8",
    "key-9",
    "key-2"
  ]);
  // Still at the end, still unconfirmed: history moving it is the whole defect.
  expect(state.roomMessages[7][3].id).toBeUndefined();
});
