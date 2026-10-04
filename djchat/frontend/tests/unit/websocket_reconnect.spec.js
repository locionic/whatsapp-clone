/* eslint-env jest */
/**
 * Websocket reconnection, and when the socket gets connected at all.
 *
 * The first bug this pins: `onclose` was an empty function, so one daphne
 * restart -- or one network blip -- ended real-time updates for that tab for
 * the rest of the session. Nothing errored; the chat simply stopped updating.
 * Nothing on the Django side can see that, which is why this has to be checked
 * here.
 *
 * The second: `created()` awaited six data fetches and connected the socket on
 * the last line. So one rejected fetch -- a 500 from `/api/v1/me`, one dropped
 * request -- meant `initializeWebSocketSupport()` never ran, and the tab then
 * had no socket at all for the rest of the session. Equally silent, and unlike
 * a failed fetch it has no reload that reliably helps, because the six fetches
 * repeat every load and any one of them can be the one that fails.
 */
import { shallowMount } from "@vue/test-utils";
import App from "@/App.vue";

const { methods } = App;
const DELAYS = [2000, 4000, 8000, 16000, 30000, 30000];

function fakeComponent() {
  return {
    retryDelay: undefined,
    initializeWebSocketSupport: methods.initializeWebSocketSupport,
    reconnectWebSocket: methods.reconnectWebSocket
  };
}

function stubWebSocket() {
  const sockets = [];
  global.WebSocket = jest.fn(function(url) {
    this.url = url;
    sockets.push(this);
  });
  return sockets;
}

beforeEach(() => {
  jest.useFakeTimers();
  setTimeout.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test("a socket that closes is retried", () => {
  const sockets = stubWebSocket();
  const vm = fakeComponent();

  methods.initializeWebSocketSupport.call(vm);
  sockets[0].onclose();

  expect(setTimeout).toHaveBeenCalledTimes(1);
  expect(setTimeout.mock.calls[0][1]).toBe(2000);
});

test("the wait between attempts doubles and then stops at thirty seconds", () => {
  // A server that is genuinely down should not be hammered, but a long enough
  // gap makes the tab look dead long after the server came back.
  const vm = fakeComponent();
  const waits = DELAYS.map(() => {
    methods.reconnectWebSocket.call(vm);
    return setTimeout.mock.calls[setTimeout.mock.calls.length - 1][1];
  });

  expect(waits).toEqual(DELAYS);
});

test("a socket that opened again starts over from one second", () => {
  // Otherwise one blip leaves every later retry waiting 30s.
  const sockets = stubWebSocket();
  const vm = fakeComponent();

  methods.reconnectWebSocket.call(vm); // backoff climbs to 2000
  methods.initializeWebSocketSupport.call(vm);
  sockets[0].onopen();

  expect(vm.retryDelay).toBe(1000);
});

test("the socket scheme follows the page protocol", () => {
  // Hardcoded wss can never reach a local `npm run serve` over http, which
  // turns the retry above into an endless reconnect loop in development.
  const sockets = stubWebSocket();

  methods.initializeWebSocketSupport.call(fakeComponent());
  expect(sockets[0].url).toBe("ws://localhost/ws/notifications/");

  delete window.location;
  window.location = { protocol: "https:", host: "chat.example" };

  methods.initializeWebSocketSupport.call(fakeComponent());
  expect(sockets[1].url).toBe("wss://chat.example/ws/notifications/");
});

// Everything below is about *when* the socket is connected, not what happens
// to it afterwards.

const LOAD_FETCHES = [
  "fetchUserProfile",
  "fetchSentInvitations",
  "fetchReceivedInvitations",
  "fetchRooms",
  "fetchUnreadMessages",
  "fetchMessages",
  "fetchRecentActivity"
];

function mountApp({ fail = null, hang = false } = {}) {
  const sockets = stubWebSocket();
  const dispatch = jest.fn(action => {
    if (hang) return new Promise(() => {}); // never settles
    return action === fail
      ? Promise.reject(new Error("offline"))
      : Promise.resolve();
  });
  const store = { commit: jest.fn(), dispatch };
  return {
    sockets,
    dispatch,
    wrapper: shallowMount(App, { mocks: { $store: store } })
  };
}

// `setImmediate`, not `setTimeout`: the beforeEach fakes timers, and a faked
// setTimeout never calls back -- so a setTimeout-based settle turns a failing
// assertion into a 5s timeout, which proves nothing about the production code.
// setImmediate is not faked, and it runs after the microtask queue has drained.
const settle = () => new Promise(resolve => setImmediate(resolve));

test("the socket is up before the first fetch comes back", () => {
  // The mechanism the fix relies on, pinned directly: a fetch that never
  // settles must not be able to hold the socket hostage.
  const { sockets } = mountApp({ hang: true });

  expect(sockets).toHaveLength(1);
});

test("no failing load fetch costs you the socket", () => {
  // Named per action so a failure says which fetch broke it, rather than
  // reporting seven identical assertion failures.
  const connected = [];
  LOAD_FETCHES.forEach(fail => {
    const { sockets, wrapper } = mountApp({ fail });
    connected.push(`${fail}: ${sockets.length}`);
    wrapper.destroy();
  });

  expect(connected).toEqual(LOAD_FETCHES.map(name => `${name}: 1`));
});

test("a load with nothing failing still connects exactly one socket", async () => {
  // The obvious way to break the fix: connect once eagerly, connect again at
  // the end of the chain, and leave every tab holding two sockets. This one
  // has to *wait* for the chain, so it settles rather than asserting
  // synchronously -- otherwise it would pass before the second connect.
  const { sockets } = mountApp({});

  await settle();
  expect(sockets).toHaveLength(1);
});

test("one failed load fetch does not cancel the other six", async () => {
  // These seven were awaited one after another, and an awaited chain stops at
  // the first rejection -- so `fetchUserProfile`, which runs first, deciding
  // the fate of all six behind it. An expired session answers that one request
  // with a 401 and the app comes up completely empty: no rooms, no messages,
  // no invitations. There is no router guard and nothing on this side that
  // navigates on failure, so "empty" is all the user ever sees of it.
  const { dispatch } = mountApp({ fail: "fetchUserProfile" });

  await settle();

  LOAD_FETCHES.slice(1).forEach(action =>
    expect(dispatch).toHaveBeenCalledWith(action)
  );
});

test("every load fetch starts without waiting for any of the others", async () => {
  // The part `Promise.all` is actually for, and the guard on the fix above: a
  // serial chain issues fetch N+1 only once fetch N has resolved, so one request
  // that never comes back holds the other six for the whole session. A promise
  // that never settles is exactly that case -- with it, a serial chain can
  // only ever have issued the first.
  const { dispatch } = mountApp({ hang: true });

  await settle();

  // Sorted, and compared as a set: this asserts that nothing was dropped or
  // left waiting, not that they happen to run in some particular order --
  // which is precisely the constraint the fix removed.
  expect(dispatch.mock.calls.map(([action]) => action).sort()).toEqual(
    LOAD_FETCHES.slice().sort()
  );
});

// Everything below is what happens *after* a push arrives, which is item 16's
// defect one function over -- and on the path that runs every single time
// somebody sends a message.

function pushApp({ fail = null } = {}) {
  const sockets = stubWebSocket();
  const commit = jest.fn();
  const dispatch = jest.fn(action =>
    action === fail ? Promise.reject(new Error("offline")) : Promise.resolve()
  );
  methods.initializeWebSocketSupport.call({
    ...fakeComponent(),
    $store: { commit, dispatch }
  });
  return { sockets, commit, dispatch };
}

const push = (sockets, payload) =>
  sockets[0].onmessage({ data: JSON.stringify(payload) });

test("a failed unread fetch still fetches the messages", () => {
  // The two are independent -- one is the tab's unread count, the other is the
  // messages themselves -- so neither should be able to cancel the other. This
  // was the worst of the four: `fetchMessages` was the *second* await, so one
  // failed count meant no new messages rendered, on a socket that stayed open
  // and healthy and so never triggered the reconnect that might have fixed it.
  const { sockets, dispatch } = pushApp({ fail: "fetchUnreadMessages" });

  push(sockets, { message: "update" });

  expect(dispatch).toHaveBeenCalledWith("fetchMessages");
});

test("a failed refresh does not escape the handler as an unhandled rejection", async () => {
  // What the three bare `dispatch(...)` calls on update_rooms,
  // update_received and update_sent actually did with a failure: nothing.
  // Nothing awaits a WebSocket event handler, so the rejection had no caller
  // to reach -- it surfaced as console noise in the browser, and under node it
  // takes the process down, which is how item 10 was found. Observed directly
  // rather than inferred, because "no unhandled rejection" is otherwise the
  // one failure mode a passing test cannot see.
  jest.useRealTimers();
  const escaped = [];
  const record = reason => escaped.push(reason);
  process.on("unhandledRejection", record);

  ["update", "update_rooms", "update_received", "update_sent"].forEach(
    message => {
      const { sockets } = pushApp({ fail: "fetchMessages" });
      const { sockets: roomsSockets } = pushApp({ fail: "fetchRooms" });
      push(sockets, { message });
      push(roomsSockets, { message });
    }
  );

  await settle();
  await settle(); // node reports an unhandled rejection a tick after the fact
  process.removeListener("unhandledRejection", record);

  expect(escaped).toEqual([]);
});

// ---------------------------------------------------------------------------
// The read-receipt half of the socket.
//
// `App.vue:64-71` is the *only* consumer of `update_message` in the whole
// client, and `chat/models.py:73-86` is the only producer of it: when the last
// pending reception goes, and then when the last pending read goes, the server
// group-sends the message id with `kind` set to one of exactly two strings.
//
// Nothing asserted any of it. The four messages the spec above pushes are the
// ones that `dispatch` a fetch -- `update`, `update_rooms`, `update_received`,
// `update_sent` -- and `update_message` was simply not among them, so the branch
// never ran in this suite. A typo in either `kind` literal, or in either
// mutation name, leaves every test here green: the receipts then stop updating
// live, and the failure is silent in the same way the two bugs this file was
// written for were -- the message keeps whatever the last fetch told it, so the
// double tick is simply late or missing, with nothing in the console.
// `read_receipts.spec.js` covers the other end, where the store override
// becomes pixels; this covers the wire.
test.each([
  ["all_received", "MARK_MESSAGE_ALL_RECEIVED"],
  ["all_read", "MARK_MESSAGE_ALL_READ"]
])("an %s push marks that message in the store", (kind, mutation) => {
  const { sockets, commit } = pushApp();

  push(sockets, { message: "update_message", data: { kind, message_id: 7 } });

  // The id, not the whole message: both mutations are keyed by message id
  // (`mutations.js:137-141`), and the server only sends the id. Committing the
  // payload instead would key the store off an object and the lookup in
  // `SentMessage.vue` would never hit -- so the payload and the key are pinned
  // together rather than one at a time.
  expect(commit).toHaveBeenCalledWith(mutation, 7);
  expect(commit).toHaveBeenCalledTimes(1);
});

test("a receipt kind nobody handles is dropped, not guessed at", () => {
  // The `if`/`else if` chain has no `else`, so an unrecognised `kind` reaches
  // nothing. That is the right shape to pin: a future `else` arm that commits
  // "probably read" would mark every message in the room as read on any push
  // the client did not recognise, and the bug would look like a server
  // announcing something new rather than like a client guessing.
  const { sockets, commit } = pushApp();

  push(sockets, {
    message: "update_message",
    data: { kind: "deleted", message_id: 7 }
  });

  expect(commit).not.toHaveBeenCalled();
});
