/* eslint-env jest */
/**
 * The app's load path: `syncDB`, and the three actions that dispatch it.
 *
 * Measured, not assumed. `syncDB` has **zero** coverage - all three of its
 * statements were unrun - and it is the only thing in the app that commits
 * `SET_ROOMS`, `SET_USERS` and `LINK_MESSAGES_TO_ROOM` together. Its three
 * mutations are individually well tested (`room_message_order.spec.js`'s nine
 * cases), so a green suite said nothing about the composition.
 *
 * **Why the composition is the risk.** `App.vue:114-123` fires all seven load
 * fetches in one `Promise.all`, so `fetchRooms`, `fetchRecentActivity` and
 * `fetchMessages` are in flight *simultaneously* and their `syncDB` calls land in
 * whatever order the network finishes - not the order they are written in. Each
 * one carries a **partial** payload, and they are partial in different ways:
 *
 *     /rooms/        every room you are in
 *     /rooms/recents only the 10 most recently active
 *     /messages/     rooms rebuilt from *pending messages only*, and users
 *                    from just those rooms' participants (`messageViews.py`)
 *
 * So the same room, and the same user, are written by several of them, and the
 * union is what the app must end up with. That only holds because `SET_ROOMS`
 * and `SET_USERS` merge additively instead of clearing. There is no code that
 * says so, and no test that would notice if it stopped.
 *
 * **A correction to two comments, on the record.** `mutations.js:3-8` and
 * `room_message_order.spec.js:8` both justify the id-sort with "App.vue awaits
 * fetchRooms before fetchMessages". That stopped being true when the awaits
 * became a `Promise.all` - the claim is what made the ordering *look* guaranteed,
 * and nothing enforces it. The right reason to sort is that the arrival order is
 * not specified, which is what the reverse-order test below pins.
 *
 * `commit` is wired to the real mutations rather than a `jest.fn()`, because the
 * subject is the composition. A spy would pass no matter which mutation name got
 * which payload - crossing `rooms` and `users` in `syncDB` is invisible to
 * every other test in the suite, and empties the sidebar.
 */
import actions from "@/store/actions.js";
import mutations from "@/store/mutations.js";

/**
 * One deferred per endpoint, so a test can choose the arrival order instead of
 * assuming it. Resolving them in a given order *is* the race: each action's
 * `.then` runs as its own response settles, so whichever is resolved first is
 * the one whose `syncDB` lands first.
 */
const deferred = () => {
  let settle;
  const promise = new Promise(resolve => {
    settle = resolve;
  });
  return { promise, settle };
};

const mockGates = {};
const bodies = {};

jest.mock("@/backend", () => ({
  get: jest.fn(url => mockGates[url].promise),
  post: jest.fn(() => Promise.resolve({ data: {} })),
  default: {}
}));

const ROOMS = "/api/v1/rooms/";
const RECENTS = "/api/v1/rooms/recents";
const MESSAGES = "/api/v1/messages/";

/**
 * One store, with `commit` doing exactly what Vuex's does.
 *
 * `dispatch` closes over `s` rather than using `this`, because an action
 * destructures its own context - `fetchMessages({ dispatch })` at `actions.js:39`
 * - and Vuex's `dispatch` is a bound method. Rebuilt as an unbound one, every
 * nested `dispatch("syncDB")` throws on `this` before the assertion runs.
 */
const store = () => {
  const s = {
    state: {
      rooms: {},
      users: {},
      roomMessages: {},
      receivedMessages: {},
      sendingPool: new Map()
    },
    commit(name, payload) {
      mutations[name](s.state, payload);
    }
  };
  s.dispatch = (name, payload) => actions[name](s, payload);
  return s;
};

const msg = (id, room = 7) => ({
  id,
  room,
  body: `m${id}`,
  front_key: `key-${id}`
});
const room = (id, lastMessage = null) => ({
  id,
  group_name: `r${id}`,
  last_message: lastMessage
});
const user = id => ({ id, username: `u${id}`, email: `u${id}@example.com` });

const payload = ({ rooms = [], users = [], messages = [] }) => ({
  rooms,
  users,
  messages
});

/** Release `url` with `body`, as its HTTP response arriving. */
const arrive = (url, body) => mockGates[url].settle({ data: body });

const idsIn = (state, roomId = 7) => state.roomMessages[roomId].map(m => m.id);

/** Let every already-resolved continuation run. */
const settleAll = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  [ROOMS, RECENTS, MESSAGES].forEach(url => {
    mockGates[url] = deferred();
  });
  bodies[ROOMS] = payload({});
  bodies[RECENTS] = payload({});
  bodies[MESSAGES] = payload({});
});

test("one syncDB commits rooms, users and messages from its own three keys", () => {
  // The isolation this file buys. Each of the three commits could be handed the
  // wrong payload - `commit("SET_USERS", rooms)` reads perfectly well and empties
  // the sidebar - and nothing else in the suite would notice, because every
  // other test either drives a mutation directly or spies on `commit` and only
  // checks a name.
  const commit = jest.fn();

  actions.syncDB(
    { commit },
    {
      rooms: [room(7, 5)],
      users: [user(9)],
      messages: [msg(5)]
    }
  );

  expect(commit.mock.calls).toEqual([
    ["SET_ROOMS", [room(7, 5)]],
    ["SET_USERS", [user(9)]],
    ["LINK_MESSAGES_TO_ROOM", [msg(5)]]
  ]);
  // Order is not incidental: `LINK_MESSAGES_TO_ROOM` needs `state.rooms` to
  // exist before anything renders, and `SET_USERS` has to land before a
  // ReceivedMessage resolves its author (`ReceivedMessage.vue:47-51`).
  expect(commit.mock.calls.map(([name]) => name)).toEqual([
    "SET_ROOMS",
    "SET_USERS",
    "LINK_MESSAGES_TO_ROOM"
  ]);
});

test("loading in the order the comments describe reads oldest first", async () => {
  // `/rooms/` ships each room's newest message; `/messages/` ships the older
  // pending ones. This is the arrival order `mutations.js:3-8` and
  // `room_message_order.spec.js:8` describe, kept as the baseline the next test
  // is measured against rather than deleted.
  const s = store();
  bodies[ROOMS] = payload({ messages: [msg(5)] });
  bodies[MESSAGES] = payload({ messages: [msg(1), msg(2), msg(3), msg(4)] });

  const loading = Promise.all([
    s.dispatch("fetchRooms"),
    s.dispatch("fetchMessages")
  ]);
  arrive(ROOMS, bodies[ROOMS]);
  await settleAll();
  // The order under test, asserted rather than assumed: /rooms/ has answered
  // and its newest message is alone in the room before /messages/ replies. This
  // and the next test's mirror are what make the pair non-vacuous - see the
  // append-only reversion in PLAN.md, where this one fails and the other passes.
  expect(idsIn(s.state)).toEqual([5]);
  arrive(MESSAGES, bodies[MESSAGES]);
  await loading;

  expect(idsIn(s.state)).toEqual([1, 2, 3, 4, 5]);
});

test("loading in the other order reads oldest first too", async () => {
  // The half that was never measured, and the one the app actually depends on.
  // `Promise.all` does not sequence, so `fetchMessages` answering first is
  // ordinary rather than exceptional - a cold cache makes it *likely*. Before
  // item 9's sort, this is the order that put every chat's newest message at the
  // top of the thread; nothing since has checked the fix holds here, because
  // every ordering test on record drives the mutation in one fixed sequence.
  const s = store();
  bodies[ROOMS] = payload({ messages: [msg(5)] });
  bodies[MESSAGES] = payload({ messages: [msg(1), msg(2), msg(3), msg(4)] });

  const loading = Promise.all([
    s.dispatch("fetchMessages"),
    s.dispatch("fetchRooms")
  ]);
  arrive(MESSAGES, bodies[MESSAGES]);
  await settleAll();
  // The mirror of the previous test: the older batch is in the room, on its own,
  // before /rooms/ has answered. Under an append-only merge this test passes and
  // the previous one fails - the pair cannot both be vacuous.
  expect(idsIn(s.state)).toEqual([1, 2, 3, 4]);
  arrive(ROOMS, bodies[ROOMS]);
  await loading;

  expect(idsIn(s.state)).toEqual([1, 2, 3, 4, 5]);
});

test("all three landing together reads oldest first in every arrival order", async () => {
  // The real thing rather than a two-way approximation: `/rooms/recents` is the
  // third writer to the same maps, and it carries the *same* `last_message` the
  // `/rooms/` payload does, so the duplicate has to be deduped and shown once.
  // All six orders, because the point is that none of them is privileged.
  bodies[ROOMS] = payload({
    rooms: [room(7, 5), room(8, 9)],
    users: [user(9)],
    messages: [msg(5), msg(9, 8)]
  });
  bodies[RECENTS] = payload({
    // Only the 10 most recent rooms, and its own last_message view of the same
    // room - a message the /rooms/ payload already delivered.
    rooms: [room(7, 5)],
    users: [user(9)],
    messages: [msg(5)]
  });
  bodies[MESSAGES] = payload({
    messages: [msg(1), msg(2), msg(3), msg(4), msg(5)]
  });

  const orders = [
    [ROOMS, RECENTS, MESSAGES],
    [ROOMS, MESSAGES, RECENTS],
    [RECENTS, ROOMS, MESSAGES],
    [RECENTS, MESSAGES, ROOMS],
    [MESSAGES, ROOMS, RECENTS],
    [MESSAGES, RECENTS, ROOMS]
  ];

  for (const order of orders) {
    [ROOMS, RECENTS, MESSAGES].forEach(url => {
      mockGates[url] = deferred();
    });
    const s = store();

    // Dispatch all three first: in flight together, as `Promise.all` has them.
    const loading = Promise.all([
      s.dispatch("fetchRooms"),
      s.dispatch("fetchRecentActivity"),
      s.dispatch("fetchMessages")
    ]);

    for (const url of order) {
      await settleAll();
      arrive(url, bodies[url]);
    }
    await loading;

    // The last_message `/rooms/` and `/recents/` share is shown once, not twice.
    expect(idsIn(s.state)).toEqual([1, 2, 3, 4, 5]);
    // And the room only `/rooms/` mentioned survives the other two payloads.
    expect(idsIn(s.state, 8)).toEqual([9]);
  }
});

test("a narrow payload does not erase a wide one that arrived first", () => {
  // The invariant that makes three racing partial payloads safe, and the one
  // most likely to be broken by a well-meaning "fix". `/messages/` rebuilds its
  // `rooms` from pending messages only, so it is routinely a strict subset of
  // `/rooms/`'s. If `SET_ROOMS` cleared before merging - which is what every
  // other setter in this store does, `SET_SENT_INVITATIONS` and
  // `SET_RECEIVED_INVITATIONS` at `mutations.js:174-186` both reset to `{}`
  // first - then whichever of the three responses landed last would erase the
  // rest, and the sidebar would show only the rooms with pending messages.
  const s = store();
  const { state } = s;

  mutations.SET_ROOMS(state, [room(7, 5), room(8, 9)]);
  mutations.SET_USERS(state, [user(9), user(10)]);

  // A later, narrower payload, as `/messages/` or `/rooms/recents` sends.
  mutations.SET_ROOMS(state, [room(7, 5)]);
  mutations.SET_USERS(state, [user(9)]);

  // Numerically, not `.sort()`: `Object.keys` sorts as strings, so ids 9 and
  // 10 come back `["10", "9"]` and the assertion would be testing sort order
  // rather than membership.
  expect(
    Object.keys(state.rooms)
      .map(Number)
      .sort((a, b) => a - b)
  ).toEqual([7, 8]);
  expect(
    Object.keys(state.users)
      .map(Number)
      .sort((a, b) => a - b)
  ).toEqual([9, 10]);
});

test("a room with no messages yet survives the load", async () => {
  // A real shape rather than a hypothetical: `RecentRoomsAPIView` does
  // `messages.add(room_data['last_message'])`, and for a room nobody has posted
  // in that is `None`. The set then holds `None` among message ids,
  // `filter(id__in=...)` ignores it, and the room simply ships no message - so
  // it arrives with `last_message: null` and must still be in the sidebar.
  const s = store();
  bodies[RECENTS] = payload({
    rooms: [room(11, null)],
    users: [user(9)],
    messages: []
  });

  const loading = s.dispatch("fetchRecentActivity");
  arrive(RECENTS, bodies[RECENTS]);
  await loading;

  expect(s.state.rooms[11]).toEqual(room(11, null));
  expect(s.state.users[9]).toEqual(user(9));
  // Nothing to render, and nothing invented for it.
  expect(s.state.roomMessages[11]).toBeUndefined();
});
