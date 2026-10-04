/* eslint-env jest */
/**
 * The ten branch arms in `mutations.js` that nothing has ever taken.
 *
 * Item 99 measured them and item 100 left them as the last number in the
 * frontend that is not 100 -- `mutations.js` at 72.22% branch. All ten are
 * defensive guards, and the honest thing to say about them is that **none is
 * reachable through the app's own mutations today**. Every `commit` passes what
 * the server sent, every room a message belongs to has been through
 * `LINK_MESSAGES_TO_ROOM` first, and every unread id came off the server's own
 * pending list. So this file pins no defect. It pins the guards themselves.
 *
 * **Why pin an unreachable branch at all**, which is the question this file has
 * to answer before it can justify existing: the alternative is deleting them,
 * and one of them turns into a corruption when it is wrong. `LINK_MESSAGES_TO_ROOM`
 * does
 *
 *     const at = inRoom.findIndex(one => one.front_key === front_key);
 *     at === -1 ? mergeMessages(inRoom, [element]) : [...inRoom.slice(0, at), ...]
 *
 * and the `: [...slice]` half is what a `findIndex` of `-1` destroys -- it drops
 * the **last** message in the room and puts the confirmation in its place,
 * silently, for a user looking at a conversation that is now wrong. The comment
 * at `mutations.js:82-85` says as much and calls the state unreachable; item 97
 * added a mutation that removes messages out from under a room, which is what
 * "one mutation away" means in practice. A guard that costs three lines and
 * prevents silent data loss is not dead code, it is cheap, and this is the
 * runnable check that keeps it from being tidied away by someone reading a
 * coverage report and finding a third of it uncovered.
 *
 * The other seven are `if (payload)` and `state.roomMessages[room] || []`: guards
 * against a malformed response throwing inside a Vuex mutation, which would
 * surface as an action rejection with no error shown. Same reasoning, less
 * dramatic, and the same reason not to delete them: they look removable, and
 * that is precisely why a test should say they are not.
 */
import mutations from "@/store/mutations.js";

const freshState = () => ({
  rooms: {},
  users: {},
  roomMessages: {},
  receivedMessages: {},
  searchResults: {},
  unreadMessages: {},
  allReceived: {},
  allRead: {},
  sentInvitations: {},
  receivedInvitations: {},
  sendingPool: new Map()
});

// Six mutations take a payload and do nothing at all when it is falsy. One
// table rather than six near-identical tests, and named rather than discovered,
// so a seventh guard that is *not* in here is a deliberate omission.
const NO_PAYLOAD = [
  "SET_ROOMS",
  "SET_USERS",
  "LINK_MESSAGES_TO_ROOM",
  "SET_SEARCH_RESULTS",
  "ADD_UNREAD_MESSAGES",
  "SET_SENT_INVITATIONS",
  "SET_RECEIVED_INVITATIONS"
];

test("a mutation given nothing to do, does nothing", () => {
  // Three of these **replace** their map wholesale, so the guard is the only
  // thing between a caller that passed nothing and a wiped sidebar. That is not
  // hypothetical shape-reading: `ADD_UNREAD_MESSAGES` had its reset *above* the
  // guard and this test is what found it, so the two halves were in the wrong
  // order and the guard did not protect the statement that could lose data.
  // `SET_RECEIVED_INVITATIONS` had no guard at all until the same pass.
  //
  // Asserted on the resulting state rather than on "did not throw", because a
  // `TypeError` swallowed upstream would satisfy the weaker version -- which is
  // the other half of the same bug, and is why `SET_RECEIVED_INVITATIONS` is
  // reported by name in the `broke` list rather than merely tolerated.
  const broke = [];
  for (const name of NO_PAYLOAD) {
    const state = freshState();
    state.rooms[1] = { id: 1 };
    state.users[1] = { id: 1 };
    state.roomMessages[7] = [{ id: 1, front_key: "key-1" }];
    state.searchResults[1] = { id: 1 };
    state.unreadMessages[1] = 7;
    state.sentInvitations[1] = { id: 1 };
    state.receivedInvitations[1] = { id: 1 };

    try {
      mutations[name](state, undefined);
    } catch (error) {
      broke.push(`${name} threw ${error.message}`);
      continue;
    }
    if (!Object.keys(state.rooms).length) broke.push(`${name} cleared rooms`);
    if (!Object.keys(state.users).length) broke.push(`${name} cleared users`);
    if (!state.roomMessages[7].length) broke.push(`${name} cleared the thread`);
    if (!state.searchResults[1]) broke.push(`${name} cleared search results`);
    if (!state.unreadMessages[1]) broke.push(`${name} cleared unread`);
    if (!state.sentInvitations[1]) broke.push(`${name} cleared sent`);
    if (!state.receivedInvitations[1]) broke.push(`${name} cleared received`);
  }

  expect(broke).toEqual([]);
});

test("an empty list still clears, because that is what the reset is for", () => {
  // The half of the guard change that could have broken real behaviour: `[]` is
  // truthy in JS, so "you have no unread messages" still empties the badges.
  // This is the case the reset was written for, and it is the one the previous
  // arrangement got right by accident.
  const state = freshState();
  state.unreadMessages[1] = 7;

  mutations.ADD_UNREAD_MESSAGES(state, []);

  expect(state.unreadMessages).toEqual({});
});

// ------------------------------------------------ the two that cost something

test("a confirmation for a room the store has never seen lands instead of corrupting", () => {
  // Line 86's uncovered arm, and line 77's with it: `sendingPool` holds the key
  // -- so `SendForm` did commit an optimistic message -- while
  // `roomMessages[element.room]` is undefined, so `inRoom` is the `|| []`
  // fallback and `findIndex` returns -1.
  //
  // Reached by constructing the state directly, because nothing in the app
  // produces it. That is the point: the assertion is about what this code does
  // *if* it is reached, so it has to be written against the state rather than
  // against a caller, and there is no caller to write it against.
  const state = freshState();
  const confirmed = { id: 9, room: 7, body: "typed", front_key: "key-1" };
  state.sendingPool.set("key-1", { ...confirmed, sending: true });

  mutations.LINK_MESSAGES_TO_ROOM(state, [confirmed]);

  // Appended. The wrong answer -- slicing from -1 -- would have produced `[]`
  // here, indistinguishable from "the room was empty" until the user noticed a
  // message of theirs had gone.
  expect(state.roomMessages[7]).toEqual([confirmed]);
  // And the in-flight registration is still cleared, or the same confirmation
  // arriving twice would be taken as a new message.
  expect(state.sendingPool.size).toBe(0);
});

test("the last message of a room survives a confirmation that finds nothing to replace", () => {
  // The same branch with something to lose, which is what makes the one above
  // mean anything. A neighbour is present, the optimistic bubble is not, and a
  // `findIndex` of -1 sliced from the end would take the neighbour with it.
  const state = freshState();
  const neighbour = { id: 1, room: 7, body: "earlier", front_key: "key-1" };
  state.roomMessages[7] = [neighbour];
  state.sendingPool.set("key-2", {
    room: 7,
    body: "typed",
    front_key: "key-2"
  });

  mutations.LINK_MESSAGES_TO_ROOM(state, [
    { id: 9, room: 7, body: "typed", front_key: "key-2" }
  ]);

  expect(state.roomMessages[7].map(one => one.front_key)).toEqual([
    "key-1",
    "key-2"
  ]);
});

test("taking back a refused message in a room with no thread does not throw", () => {
  // Line 157's `|| []`, in `REMOVE_FAILED_MESSAGE`. Unreachable today -- the
  // optimistic message went through `LINK_MESSAGES_TO_ROOM`, which creates the
  // room's entry -- so the covered half of that `||` is the half that was never
  // broken and this one is untested. `failed_send.spec.js` always seeds
  // `roomMessages[7]` first, which is why its two hits are both on the other
  // side.
  const state = freshState();

  expect(() =>
    mutations.REMOVE_FAILED_MESSAGE(state, { front_key: "key-1", room: 7 })
  ).not.toThrow();
  // The key still goes: a refusal that could not be applied at all would leave
  // the bubble claiming to be on its way, which is the defect item 10 fixed.
  expect(state.sendingPool.size).toBe(0);
  expect("key-1" in state.receivedMessages).toBe(false);
});

test("clearing a read receipt for a message the store does not have is a no-op", () => {
  // Line 208's `if (message_id in state.unreadMessages)`. The guard's only
  // effect is to skip a `Vue.delete` on a key that is not reactive, and here the
  // uncovered arm is the *common* one rather than an exotic one -- so the
  // honest description is that nothing sends it. `markMessageAsRead` calls this
  // after a successful POST, and by then the message has usually been cleared
  // already by `ADD_UNREAD_MESSAGES` from the unread fetch.
  const state = freshState();

  expect(() => mutations.REMOVE_MESSAGE_FROM_UNREAD(state, 99)).not.toThrow();
  expect(state.unreadMessages).toEqual({});
});
