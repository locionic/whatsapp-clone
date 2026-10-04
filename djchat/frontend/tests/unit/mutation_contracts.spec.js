/* eslint-env jest */
/**
 * The eight mutations `unread_axis.spec.js` did not reach.
 *
 * Item 78 pinned that fifteen actions request the right commits. Eight of those
 * commits had themselves never run, because the specs that mention them mount
 * with `commit: jest.fn()` -- `closed_room.spec.js:47`,
 * `keyboard_reach.spec.js:51,84`, `window_size.spec.js:40`, and item 78's own
 * spec, which passes `{ commit: commits }`. A `jest.fn()` accepts any name, so
 * a mutation renamed in `mutations.js` and left behind in four places would pass
 * every test and write into a field nothing renders.
 *
 * Plain functions over plain state, no mounting and no axios -- `unread_axis`-
 * `spec.js`'s rule, and the reason this file asserts about the mutations rather
 * than about Vue.
 */
import mutations from "@/store/mutations.js";

function freshState() {
  return {
    rooms: {},
    selectedRoom: null,
    sentInvitations: {},
    receivedInvitations: {},
    searchResults: {},
    userProfile: {},
    width: 0,
    height: 0,
    roomActivity: {}
  };
}

test("each plain mutation writes the field its own name implies", () => {
  // Five of the eight are one line each -- `state.x = payload`. The thing worth
  // pinning is not the assignment, which is the language's, but the pairing of
  // each commit name to the field it lands in. A renamed field writes somewhere
  // real and somewhere unread, and every caller of that commit is a
  // `jest.fn()` that would go on passing. So one table, one test.
  const table = [
    ["SET_SELECTED_ROOM", "selectedRoom", 7],
    ["SET_USER_PROFILE", "userProfile", { id: 1, username: "alice" }],
    ["SET_CURRENT_WIDTH", "width", 1280],
    ["SET_CURRENT_HEIGHT", "height", 720],
    ["SET_ROOM_ACTIVITY", "roomActivity", { 7: [1, 2, 3] }]
  ];

  for (const [name, field, payload] of table) {
    const state = freshState();
    mutations[name](state, payload);
    expect(state[field]).toEqual(payload);
  }
});

test("removing a chat removes that row and leaves the others", () => {
  // `REMOVE_ROOM` is what `App.vue:50-55` answers the `room_delete` push with --
  // the whole reason item 78's spec pins `deleteRoom` as committing nothing.
  // A removal that took the map with it would empty the sidebar; one that took
  // too much would leave a row pointing at a room that 404s.
  const state = freshState();
  mutations.SET_ROOMS(state, [{ id: 7 }, { id: 8 }, { id: 9 }]);

  mutations.REMOVE_ROOM(state, 8);

  expect(Object.keys(state.rooms)).toEqual(["7", "9"]);
  // Someone else's push can name a chat this store never had -- the row was
  // removed on their screen first. Throwing here would take the push handler
  // with it and strand the sidebar.
  expect(() => mutations.REMOVE_ROOM(state, 404)).not.toThrow();
  expect(Object.keys(state.rooms)).toEqual(["7", "9"]);
});

test("the three list mutations replace rather than merge, keyed by id", () => {
  // "Replace" is the load-bearing word in all three, and it is why they start
  // from `{}` rather than clearing: `SET_SENT_INVITATIONS` is what `addFriend`
  // and `cancelFriendRequest` both commit (`actions.js:195,206`), so a merge
  // would leave every invitation you ever sent on screen forever, and
  // `SET_SEARCH_RESULTS` is why a second search replaces the first.
  const table = [
    ["SET_SENT_INVITATIONS", "sentInvitations"],
    ["SET_RECEIVED_INVITATIONS", "receivedInvitations"],
    ["SET_SEARCH_RESULTS", "searchResults"]
  ];

  for (const [name, field] of table) {
    const state = freshState();
    mutations[name](state, [{ id: 1, username: "bob" }]);
    mutations[name](state, [{ id: 2, username: "carol" }]);

    expect(Object.keys(state[field])).toEqual(["2"]);
    expect(state[field][2]).toEqual({ id: 2, username: "carol" });
  }
});

test("an empty list is what empties a map, not the guard in front of it", () => {
  // `closeSearch` commits `SET_SEARCH_RESULTS` with `[]`
  // (`MessagesSection.vue:254`), so the mechanism that clears the map is
  // "reset, then re-add" -- and on this path the `if (messages)` guard never
  // even runs, because an empty array is truthy. It is `[].forEach` iterating
  // zero times that leaves it empty. Pinned, because an "add to whatever is
  // there" reversion passes every other assertion in this file.
  for (const [name, field] of [
    ["SET_SENT_INVITATIONS", "sentInvitations"],
    ["SET_RECEIVED_INVITATIONS", "receivedInvitations"],
    ["SET_SEARCH_RESULTS", "searchResults"]
  ]) {
    const state = freshState();
    mutations[name](state, [{ id: 1 }]);
    mutations[name](state, []);
    expect(state[field]).toEqual({});
  }

  // **The guard itself is unreachable, and I checked before leaning on it.**
  // `SET_SENT_INVITATIONS` and `SET_SEARCH_RESULTS` read `if (messages)`, which
  // is the only thing standing between them and a TypeError on a null payload.
  // Every current caller passes an array: `addFriend` and `cancelFriendRequest`
  // commit `response.data` from views ending in `Response(serializer.data)`
  // (`friends/api/views.py:45,100,135`), and `searchMessages` commits a DRF
  // list. So no test here exercises the guard, and none should pretend to.
  //
  // That is also the whole of the answer to `SET_RECEIVED_INVITATIONS` having no
  // guard while its two siblings do: with no falsy payload reachable, the guard
  // is unreachable there too. Adding it would be a branch no test could reach,
  // and the file this is not testing it in has better things to hold.
});