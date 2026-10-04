/* eslint-env jest */
/**
 * What the websocket does when a push arrives, as opposed to when it connects.
 *
 * `websocket_reconnect.spec.js` says in its own closing line that it covers *when*
 * the socket connects and not what happens inside it. That left the `onmessage`
 * handler's branches unpinned one at a time, and item 81's sweep found two of the
 * seven survive with nothing at all:
 *
 *     F1  update_rooms -> fetchRooms           SURVIVED, no test noticed
 *     F2  writing      -> EventBus.$emit       SURVIVED, no test noticed
 *
 * **F1 is the branch item 78's spec argues from.** `action_contracts.spec.js`
 * pins `createGroup` as committing nothing, on the grounds that "the group
 * reaches every participant's sidebar off the `update_rooms` push the view sends,
 * which `App.vue:48-49` answers with `fetchRooms`". Every word of that argument
 * was checked except the part it depends on. Delete `App.vue:48-49` and a group
 * you create simply never appears for anyone else -- no error, no console
 * message, and `action_contracts.spec.js` still green, because it asserts what
 * the action does *not* do rather than what the push then does.
 *
 * **F2 is the middle hop of a chain whose every other link is tested.**
 * `postWriting` is pinned by `action_contracts.spec.js`,
 * `RoomWritingAPIView` by the pytest suite, and `User.vue`'s `$on("writing")` by
 * `user_writing_listener.spec.js`. The hop between them -- `App.vue:62-63`, the
 * only place the push becomes an event -- was the one with no test, so
 * "X is writing..." could vanish entirely and 231 specs would pass.
 *
 * The other five branches (`update`, `room_delete`, `update_received`,
 * `update_sent`, `update_message`) are covered elsewhere and are not re-run here.
 */
import App from "@/App.vue";
import { EventBus } from "@/eventBus";

const { methods } = App;

// Same harness as `websocket_reconnect.spec.js`, plus the two things this
// handler actually touches: a store and the event bus.
function componentUnderPush() {
  return {
    retryDelay: undefined,
    initializeWebSocketSupport: methods.initializeWebSocketSupport,
    reconnectWebSocket: methods.reconnectWebSocket,
    $store: {
      // Resolved, not rejected: `App.vue:40`'s `ignoreFailure` exists because
      // nothing awaits a WebSocket handler, and a rejection here would be
      // unhandled rather than reported.
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

afterEach(() => {
  jest.restoreAllMocks();
});

const push = (component, message, data) => {
  component.initializeWebSocketSupport();
  sockets[0].onmessage({ data: JSON.stringify({ message, data }) });
  return component;
};

test("a room changed elsewhere refetches the room list", () => {
  // `RoomViewSet.create` and `RoomDeleteAPIView` both broadcast `update_rooms`
  // to the other participants, so this is the only path by which a group you
  // were added to reaches your sidebar. Asserting the exact one-argument call
  // rather than `toHaveBeenCalled`, because the handler's other branches
  // dispatch too and this one must not grow a second.
  const component = push(componentUnderPush(), "update_rooms");

  expect(component.$store.dispatch.mock.calls).toEqual([["fetchRooms"]]);
});

test("someone typing is announced with that room's payload, not ours", () => {
  // `Rooms.vue` and `User.vue` both filter on `data.room_id`, so the payload has
  // to survive the hop. Emitting a constant, or the raw envelope instead of
  // `data.data`, leaves every listener comparing `undefined` and nobody ever
  // sees the indicator.
  const emit = jest.spyOn(EventBus, "$emit");
  const data = { room_id: 7, user_id: 3 };

  push(componentUnderPush(), "writing", data);

  expect(emit).toHaveBeenCalledWith("writing", data);
});