/* eslint-env jest */
/**
 * The two requests the store builds, and the one place it cleans up.
 *
 * `actions.js` is 281 lines and has **two conditionals** in it. Both were
 * unmeasured, and so was a `commit` on the failure path. Measured, not assumed -
 * **31 suites, 175 tests, green**, four times over:
 *
 *     A1  fetchPastMessages always appends `?offset=`      (ternary dropped)
 *     A2  sendMessage never sends `front_key`             (spread deleted)
 *     A3  sendMessage never commits REMOVE_FAILED_MESSAGE
 *
 * A1 is the interesting one, because the two branches are not a detail of the
 * URL - they select two different queries on the server. `LastMessagesRoomAPIView`
 * reads `offset` and branches on it (`messageViews.py:74-85`): with one it pages
 * `id__lt=offset`, without one it takes the newest ten. So dropping the ternary
 * does not merely add a query string, it sends `?offset=undefined` to a branch
 * that answers `ParseError('offset must be a message id.')` - a 400 in the exact
 * situation that is supposed to be the one that works.
 *
 * A2 is a correction to PLAN.md rather than a new finding. Item 54 is recorded
 * as pinning "`sendMessage`'s three keys", and it does - on the **server**:
 * `test_the_created_message_carries_the_clients_front_key` POSTs a `front_key`
 * and asserts the serializer keeps it. That pins the field's acceptance, not the
 * client's sending of it, so deleting the client's spread left the suite green.
 * The two halves never check each other, which is items 61 through 68's subject
 * again, on a key rather than a field.
 *
 * A3 is the same shape one line over. `failed_send.spec.js` pins the
 * `REMOVE_FAILED_MESSAGE` *mutation* - that a refused message comes off its clock
 * and your text comes back. What nothing pinned is the action *calling* it. The
 * comment at `actions.js:85-88` is explicit that this catch is "the only place
 * that knows": `sending` is only cleared when the server's own copy comes back,
 * which after a failure it never will. Delete the commit and a refused message
 * keeps its clock forever, with the recovery logic sitting green one layer below.
 *
 * The mocking shape is `email_lookup_encoding.spec.js`'s, which already does this
 * for `getUserIdFromEmail` - no new infrastructure. Note the `jest.mock` factory
 * wraps rather than returns the mock directly, so `mockGet`/`mockPost` are read
 * at *call* time; returning them directly would hit the temporal dead zone,
 * because `jest.mock` is hoisted above the `const`.
 *
 * `Object.keys` rather than `toEqual` for the payload: `toEqual` ignores
 * properties whose value is `undefined`, so a payload carrying
 * `front_key: undefined` would compare equal to one without the key at all -
 * which is precisely the distinction the conditional spread exists to make.
 */
import actions from "@/store/actions.js";

const mockGet = jest.fn(() =>
  Promise.resolve({ data: { messages: [], users: [], room: {} } })
);
const mockPost = jest.fn(() => Promise.resolve({ data: {} }));

jest.mock("@/backend", () => ({
  get: (...args) => mockGet(...args),
  post: (...args) => mockPost(...args),
  default: {}
}));

beforeEach(() => {
  mockGet.mockClear();
  mockPost.mockClear();
});

const requestedUrl = () => mockGet.mock.calls[0][0];
const sentPath = () => mockPost.mock.calls[0][0];
const sentBody = () => mockPost.mock.calls[0][1];

test("asking for older messages names the one to go back from", async () => {
  // The paging branch, which is the server's `id__lt=offset` and not its
  // newest-ten. Both keys at once: `roomId` is the path, `firstMessageId` is the
  // query, and a mutation that swapped them would still build a plausible URL.
  await actions.fetchPastMessages(
    { commit: jest.fn() },
    { roomId: 7, firstMessageId: 3 }
  );

  expect(requestedUrl()).toBe("/api/v1/messages/7?offset=3");
});

test("asking for the newest messages asks for no offset at all", async () => {
  // The guard on A1. `toBe` on the whole URL rather than a `not.toContain`,
  // because the failing form is `?offset=undefined`, which contains nothing
  // wrong-looking - it is the trailing `?offset=` that has to be absent, and
  // only an exact comparison says so.
  await actions.fetchPastMessages({ commit: jest.fn() }, { roomId: 7 });

  expect(requestedUrl()).toBe("/api/v1/messages/7");
});

test("a sent message carries the key that ties it to the server's copy", async () => {
  // The guard on A2, and the exact set of keys - `room`, `body`, `front_key`,
  // nothing else. `front_key` is a client-generated uuid the server has no other
  // way to know, so a message whose key never left the browser can never be
  // matched to the copy that comes back over the socket.
  await actions.sendMessage(
    { commit: jest.fn() },
    { room: 7, body: "hi", front_key: "key-a" }
  );

  expect(Object.keys(sentBody()).sort()).toEqual(["body", "front_key", "room"]);
  expect(sentBody()).toEqual({ room: 7, body: "hi", front_key: "key-a" });
});

test("a send with no key omits it rather than sending nothing for it", async () => {
  // The other half of the conditional. A `front_key: undefined` would serialise
  // away in the request body but would still be a key the client believes it
  // sent, and it is the half no server test can catch - the server is never
  // shown the difference, only the client's own construction of the payload.
  await actions.sendMessage({ commit: jest.fn() }, { room: 7, body: "hi" });

  expect(Object.keys(sentBody()).sort()).toEqual(["body", "room"]);
  expect("front_key" in sentBody()).toBe(false);
});

test("a refused send takes the message off its clock", async () => {
  // The guard on A3, and item 10's caller. The mutation `failed_send.spec.js`
  // pins; what is missing is that anything calls it, so this is the only place
  // the two halves meet.
  mockPost.mockImplementationOnce(() =>
    Promise.reject(new Error("server said no"))
  );
  const commit = jest.fn();

  await expect(
    actions.sendMessage({ commit }, { room: 7, body: "hi", front_key: "key-a" })
  ).rejects.toThrow("server said no");

  // Keyed by `front_key` *and* `room`: the key is only unique within a room, so
  // a commit carrying one without the other would restore the wrong message when
  // two rooms have a failed send at the same moment.
  expect(commit).toHaveBeenCalledWith("REMOVE_FAILED_MESSAGE", {
    front_key: "key-a",
    room: 7
  });
});

test("a refused send also refuses, rather than resolving as if it worked", async () => {
  // The other half of the same `.catch`, and the reason the catch exists at all.
  // A caller that only ever looked at `resolve` would leave the optimistic bubble
  // on screen with no error: `App.created()` awaits these, and a rejection is how
  // it knows a load fetch failed.
  mockPost.mockImplementationOnce(() => Promise.reject(new Error("offline")));
  const resolve = jest.fn();

  await expect(
    actions
      .sendMessage({ commit: jest.fn() }, { room: 7, body: "hi" })
      .then(resolve)
  ).rejects.toThrow("offline");
  expect(resolve).not.toHaveBeenCalled();
});

test("a send that succeeds cleans nothing up", async () => {
  // The negative that keeps the previous two honest. On success the action
  // commits *nothing*: the bubble keeps `sending: true` until the server's own
  // copy arrives over the socket and replaces it, which is the whole reason
  // `sending` exists. A commit here would be harmless today and wrong the moment
  // the socket path changed - it would remove a message the server accepted.
  const commit = jest.fn();

  await actions.sendMessage(
    { commit },
    { room: 7, body: "hi", front_key: "key-a" }
  );

  expect(sentPath()).toBe("/api/v1/messages/");
  expect(commit).not.toHaveBeenCalled();
});
