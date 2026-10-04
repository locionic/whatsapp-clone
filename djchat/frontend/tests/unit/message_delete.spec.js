/* eslint-env jest */
/**
 * Deleting a message, on the client.
 *
 * The gap is the same one `chat/_tests/test_message_delete.py` pins on the
 * server: the app can delete a whole chat (`ContactProfile.vue:126`, and
 * `deleteRoom` in `actions.js:245`) but had no way to remove one message from
 * one, so anything you sent by mistake was permanent for both sides.
 *
 * Three hops, and each is tested where it can fail on its own:
 *
 *     SentMessage.vue    the button, on your messages only
 *     actions.js         POST /api/v1/messages/<id>/delete
 *     App.vue            the `message_delete` push -> REMOVE_MESSAGE
 *     mutations.js       the bubble goes, and so do its five bookkeeping entries
 *
 * **The removal is driven by the socket, not optimistically.** That is
 * `room_delete`'s established shape (`App.vue:50-55`) and it is the cheaper
 * design too: the server announces to every participant including the sender, so
 * one code path serves both sides and there is no snapshot to roll back. The
 * cost is that a deletion takes a round trip, and if the socket is down the
 * button appears to do nothing -- which is correct, because nothing was deleted.
 * So the action's rejection is caught rather than left unhandled: `App.vue:31-33`
 * records that a rejected dispatch in a WebSocket handler has no caller to reach.
 *
 * The mutation is the interesting one, because a delete is six entries and not
 * one. `roomMessages` is keyed by room, `unreadMessages`/`allRead`/`allReceived`
 * by message id, `receivedMessages` and `sendingPool` by `front_key` -- so
 * removing the bubble alone leaves a permanent unread badge, a permanent receipt
 * entry and a permanent in-flight registration for a message that no longer
 * exists anywhere.
 */
import { mount } from "@vue/test-utils";
import App from "@/App.vue";
import SentMessage from "@/components/messages/SentMessage.vue";
import mutations from "@/store/mutations.js";
import actions from "@/store/actions.js";

const { methods } = App;

// ------------------------------------------------------------------ the push

function componentUnderPush() {
  return {
    retryDelay: undefined,
    initializeWebSocketSupport: methods.initializeWebSocketSupport,
    reconnectWebSocket: methods.reconnectWebSocket,
    $store: {
      dispatch: jest.fn(() => Promise.resolve({})),
      commit: jest.fn()
    }
  };
}

let sockets;

beforeEach(() => {
  sockets = [];
  global.WebSocket = jest.fn(function(url) {
    this.url = url;
    sockets.push(this);
  });
});

afterEach(() => jest.restoreAllMocks());

const push = (component, message, data) => {
  component.initializeWebSocketSupport();
  sockets[0].onmessage({ data: JSON.stringify({ message, data }) });
  return component;
};

test("a deleted message is taken out of the store", () => {
  const component = push(componentUnderPush(), "message_delete", {
    message_id: 42
  });

  expect(component.$store.commit.mock.calls).toEqual([
    ["REMOVE_MESSAGE", { message_id: 42 }]
  ]);
});

test("the id is read out of the payload, not the envelope", () => {
  // The `writing` branch's lesson, from `push_handlers.spec.js:87-91`: the wire
  // shape is `{message: <event>, data: {message_id}}`, so the id is one level
  // down. Reading the envelope instead commits `REMOVE_MESSAGE` with no id,
  // which removes nothing and reports no error -- the deleted message simply
  // stays on screen until the next fetch.
  const component = push(componentUnderPush(), "message_delete", {
    message_id: 42
  });

  expect(component.$store.commit).toHaveBeenCalledWith("REMOVE_MESSAGE", {
    message_id: 42
  });
});

test("deleting also refetches the rooms, because the sidebar names the text", () => {
  // The half that is easy to leave out. `RoomSerializer.get_last_message` is the
  // sidebar's preview, so deleting the newest message leaves its text in the
  // room list until something else happens to refetch -- which is to say the
  // thing you just deleted stays on screen in the one place it is most visible.
  //
  // `Room.last_activity` is deliberately *not* bumped server-side, so this fetch
  // is the only thing that updates the preview.
  const component = push(componentUnderPush(), "message_delete", {
    message_id: 42
  });

  expect(component.$store.dispatch).toHaveBeenCalledWith("fetchRooms");
});

// -------------------------------------------------------------- the mutation

const freshState = () => ({
  rooms: {},
  users: {},
  roomMessages: { 7: [{ id: 1, room: 7, body: "first", front_key: "key-1" }] },
  receivedMessages: { "key-1": null },
  unreadMessages: { 1: 7 },
  allReceived: { 1: true },
  allRead: { 1: true },
  sendingPool: new Map()
});

const remove = (state, payload) => mutations.REMOVE_MESSAGE(state, payload);

test("the bubble goes and its neighbours stay", () => {
  const state = freshState();
  state.roomMessages[7] = [
    { id: 1, room: 7, body: "first", front_key: "key-1" },
    { id: 2, room: 7, body: "doomed", front_key: "key-2" },
    { id: 3, room: 7, body: "third", front_key: "key-3" }
  ];
  state.receivedMessages["key-2"] = null;

  remove(state, { message_id: 2 });

  expect(state.roomMessages[7].map(one => one.id)).toEqual([1, 3]);
});

test("a message in another room is not disturbed", () => {
  // The mutation has to work out which room holds the id, because the announce
  // carries the id alone -- so the failure mode is deleting from room 7 when the
  // message was in room 8. Filtering every room on the id is what makes the
  // search safe; clearing `roomMessages[room_id]` blindly is not.
  const state = freshState();
  state.roomMessages[8] = [
    { id: 9, room: 8, body: "other chat", front_key: "key-9" }
  ];

  remove(state, { message_id: 9 });

  expect(state.roomMessages[8]).toEqual([]);
  expect(state.roomMessages[7].map(one => one.id)).toEqual([1]);
});

test("the unread badge goes with it", () => {
  // `unreadMessages` is keyed by message id and is the one map a client can hold
  // an entry for a message it has *never loaded*: `fetchUnreadMessages` fills it
  // from the server's pending list, and the room it names may never be opened.
  // So this has to be cleared by id, from a search that will not find the message.
  const state = freshState();
  state.unreadMessages[99] = 8;

  remove(state, { message_id: 99 });

  expect(state.unreadMessages).toEqual({ 1: 7 });
});

test("the receipt entries go with it", () => {
  // `allRead`/`allReceived` are keyed by id and are read off `message.id` by
  // `SentMessage.vue`, so a leftover entry is inert -- but it is a permanent
  // reactive one for a message that no longer exists, which is the same shape of
  // leak `mutations.js:73` records as fixed for the send path.
  const state = freshState();

  remove(state, { message_id: 1 });

  expect(state.allRead).toEqual({});
  expect(state.allReceived).toEqual({});
  expect(state.unreadMessages).toEqual({});
});

test("the already-seen registration goes, keyed on the key of the message found", () => {
  // `receivedMessages` is keyed on `front_key`, which the announce does not carry
  // -- the client reads it off the message it found while removing it. That is
  // the one thing the search cannot be replaced by, and the one entry that would
  // grow without bound if it were missed.
  const state = freshState();
  state.roomMessages[7] = [
    { id: 1, room: 7, body: "first", front_key: "key-1" },
    { id: 2, room: 7, body: "doomed", front_key: "key-2" }
  ];
  state.receivedMessages = { "key-1": null, "key-2": null };

  remove(state, { message_id: 2 });

  expect("key-2" in state.receivedMessages).toBe(false);
  expect("key-1" in state.receivedMessages).toBe(true);
});

test("the in-flight registration goes too, and this is the only line that clears it", () => {
  // Reachable, if narrowly: the POST reached the server and the response was
  // lost, so the optimistic bubble is still in `sendingPool` -- the same window
  // `REMOVE_FAILED_MESSAGE`'s comment describes -- while the message itself
  // exists, was delivered, and can be deleted by the peer. The announce then
  // arrives for a message this client still believes is in flight, and the
  // `front_key` needed to find it is on the message that was found, nowhere else.
  const state = freshState();
  state.receivedMessages = {};
  state.sendingPool.set("key-1", { front_key: "key-1" });

  remove(state, { message_id: 1 });

  expect(state.sendingPool.size).toBe(0);
});

test("deleting a message this client never had is not an error", () => {
  // The half that makes the unread case above safe: a message whose room was
  // never opened is not in any `roomMessages` array, so the search finds
  // nothing. Throwing here would take down the WebSocket handler, which has no
  // caller to catch it -- `App.vue:31-33` records that under node that kills the
  // process.
  const state = freshState();
  state.unreadMessages[99] = 8;

  expect(() => remove(state, { message_id: 99 })).not.toThrow();
  expect(state.roomMessages[7].map(one => one.id)).toEqual([1]);
  expect(state.unreadMessages).toEqual({ 1: 7 });
});

// ----------------------------------------------------------------- the action

const mockPost = jest.fn(() => Promise.resolve({ data: {} }));

jest.mock("@/backend", () => ({
  post: (...args) => mockPost(...args),
  default: {}
}));

beforeEach(() => mockPost.mockClear());

test("deleting posts to the message's own delete route", async () => {
  await actions.deleteMessage({}, 42);

  expect(mockPost).toHaveBeenCalledWith("/api/v1/messages/42/delete");
});

test("a refused deletion is refused, so nothing unhandled escapes the click", async () => {
  // `SentMessage` dispatches this from a click handler, which has no caller to
  // await it: an unhandled rejection is console noise in a browser and, under
  // node, takes the process down. This is the same hazard `App.vue:31-33` names.
  mockPost.mockImplementationOnce(() => Promise.reject(new Error("404")));

  const resolve = jest.fn();

  await expect(
    actions
      .deleteMessage({}, 42)
      .then(resolve)
  ).rejects.toThrow("404");
  expect(resolve).not.toHaveBeenCalled();
});

test("the action touches no store, because the push is what removes the bubble", async () => {
  // If this ever starts committing, the sender's message leaves this client
  // twice: once here, and once when the `message_delete` push comes back to
  // every participant including the sender. Nothing would *look* broken --
  // `REMOVE_MESSAGE` is a find-then-filter and running it twice is a no-op --
  // so the cost of the second path is not a bug but the loss of the first
  // property: one code path, and no optimistic copy to put back when the
  // request is refused.
  const commit = jest.fn();

  await actions.deleteMessage({ commit }, 42);

  expect(commit).not.toHaveBeenCalled();
});

// ------------------------------------------------------------------ the button

// Without a control in the bubble the whole feature is unreachable, and the only
// half worth testing above is one nobody can reach. `MessagesSection.vue:140,158`
// renders this component only under `v-if="message.is_owner"`, so "your messages
// only" is the parent's rule and is not re-decided here -- one place owns it.
const bubble = (overrides = {}) => ({
  id: 42,
  room: 7,
  body: "see you at 8",
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  front_key: "key-42",
  ...overrides
});

function mountSent(message) {
  const dispatch = jest.fn(() => Promise.resolve({}));
  const wrapper = mount(SentMessage, {
    propsData: { message },
    // `unreadMessages` left empty so `created()`'s `markMessageAsRead` timer is a
    // no-op: this spec is about deleting, and that dispatch would be noise in
    // every assertion on `dispatch` below.
    mocks: {
      $store: {
        state: { allReceived: {}, allRead: {}, unreadMessages: {} },
        dispatch,
        commit: jest.fn()
      }
    }
  });
  return { wrapper, dispatch };
}

const buttonsOf = wrapper => wrapper.findAll("button");

test("a message you sent can be deleted from the bubble", () => {
  const { wrapper } = mountSent(bubble());

  expect(buttonsOf(wrapper).length).toBe(1);
});

test("a message still on its way out cannot be, because it has no id yet", () => {
  // `message.sending` is exactly "the server has not answered yet", so `id` is
  // `undefined` -- and `POST /api/v1/messages/undefined/delete` is a 404 that
  // reads as a refusal the user cannot act on. One clause, not a disabled
  // button: the server cannot be asked about a message it has not been told of.
  //
  // Both halves in one test, and that is the point of it: "the sending bubble
  // has no button" is also what a component with *no* button anywhere looks
  // like, so alone it passes against no feature at all. The control half is
  // what makes the assertion mean something.
  expect(buttonsOf(mountSent(bubble()).wrapper).length).toBe(1);
  expect(
    buttonsOf(mountSent(bubble({ sending: true, id: undefined })).wrapper).length
  ).toBe(0);
});

test("the button says what it does", () => {
  // An icon-only control. Material's `delete` glyph is not a name, and this one
  // is revealed on focus, so the name is what a screen reader and a
  // "why did this get bigger" sighted user both get. Asserted as an exact
  // string, so a rename that stops naming the action fails here.
  const { wrapper } = mountSent(bubble());

  expect(buttonsOf(wrapper).at(0).attributes("aria-label")).toBe(
    "Delete message"
  );
});

test("clicking it asks for that message and no other", () => {
  const { wrapper, dispatch } = mountSent(bubble());

  buttonsOf(wrapper).at(0).trigger("click");

  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith("deleteMessage", 42);
});

test("a refusal is said out loud rather than swallowed", async () => {
  // `deleteMessage` rejects -- a 404 from the sender-only filter, or a lost
  // response -- and the click handler has no caller to catch it. ContactProfile's
  // "Delete chat" already sets the precedent for showing it (`error` at
  // ContactProfile.vue:134); MessagesSection's `searchError` for the same reason.
  // Without the `.catch` there is no alert *and* an unhandled rejection, so this
  // one assertion catches both.
  const { wrapper, dispatch } = mountSent(bubble());
  dispatch.mockImplementationOnce(() => Promise.reject(new Error("404")));

  buttonsOf(wrapper).at(0).trigger("click");
  await wrapper.vm.$nextTick();
  await Promise.resolve();

  expect(wrapper.find('[role="alert"]').text()).toBe(
    "This message could not be deleted."
  );
});

test("the refusal does not follow you to the next attempt", () => {
  // Cleared up front, not only on success, so a retry that fails differently
  // replaces the message rather than stacking on a stale one.
  const { wrapper, dispatch } = mountSent(bubble());
  dispatch.mockImplementationOnce(() => Promise.reject(new Error("404")));

  buttonsOf(wrapper).at(0).trigger("click");
  wrapper.vm.deleteError = "This message could not be deleted.";

  expect(wrapper.vm.deleteError).toBe("This message could not be deleted.");
  wrapper.vm.deleteMessage();

  expect(wrapper.vm.deleteError).toBe("");
});