/* eslint-env jest */
/**
 * Searching a room's messages.
 *
 * Split in two because the two halves fail differently. `actions.js:54`
 * `fetchPastMessages` already owns the *same endpoint* for paging backwards, and
 * its two branches are pinned by `action_requests.spec.js` -- so the half that
 * was missing here was never the request. It was what the response does with a
 * set of messages that are **not** contiguous history.
 *
 * That is the whole difficulty. The thread in `roomMessages[roomId]` is a
 * conversation, and items 71-73 established that how messages merge into it
 * matters down to the slot each one occupies. Search results are the same
 * messages with most of their neighbours missing, so linking them in the way
 * every other message arrives would splice ten orphans into the middle of a
 * conversation. Hence a separate `searchResults` map, and a test that says so.
 *
 * The URL is built by hand, so a term containing `&` becomes a second query
 * parameter and the search silently becomes a different search. Tested, because
 * a search box is the one input in this app that invites arbitrary text, and
 * this is the only place a user-supplied string reaches a URL.
 */
import Vue from "vue";
import { mount } from "@vue/test-utils";
import actions from "@/store/actions.js";
import mutations from "@/store/mutations.js";
import MessagesSection from "@/components/messages/MessagesSection.vue";

let mockGet;
jest.mock("@/backend", () => ({
  get: jest.fn((...args) => mockGet(...args)),
  post: jest.fn(() => Promise.resolve({ data: {} })),
  default: {}
}));

const found = (id, body) => ({
  id,
  room: 7,
  body,
  is_owner: false,
  timestamp: "2026-01-01T10:00:00Z",
  front_key: `key-${id}`,
  author: 9,
  all_received: false,
  all_read: false
});

const openChat = () =>
  Vue.observable({
    selectedRoom: 7,
    sendingPool: new Map(),
    receivedMessages: {},
    roomMessages: { 7: [found(1, "in the thread")] },
    unreadMessages: {},
    users: { 9: { id: 9, username: "Bob", email: "bob@example.com" } },
    allReceived: {},
    allRead: {},
    rooms: { 7: { id: 7, group_name: "Bob" } },
    searchResults: {}
  });

const mountChat = state =>
  mount(MessagesSection, {
    mocks: {
      $store: {
        state,
        // The real `SET_SEARCH_RESULTS`, not `jest.fn()`. Two of the tests below
        // assert that closing a search empties `state.searchResults`, and with a
        // mocked commit that assertion would hold for a component that clears
        // nothing at all -- the assertion would be measuring the mock. Every
        // other mutation is inert here, as it was in `incoming_message.spec.js`.
        commit: (name, payload) => mutations[name](state, payload),
        // Never settles: the scroll watchers must not fetch anything here.
        dispatch: jest.fn(() => new Promise(() => {}))
      }
    }
  });

beforeAll(() => {
  // jsdom has no layout, so `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

beforeEach(() => {
  mockGet = jest.fn(() =>
    Promise.resolve({
      data: {
        messages: [found(90, "the ticket is booked")],
        users: [{ id: 9, username: "Bob", email: "bob@example.com" }],
        room: { id: 7, group_name: "Bob" }
      }
    })
  );
});

test("a search asks the server for that room's messages matching the term", async () => {
  await actions.searchMessages({ commit: jest.fn() }, { room: 7, term: "ticket" });

  expect(mockGet.mock.calls[0][0]).toBe("/api/v1/messages/7?search=ticket");
});

test("a term with an ampersand does not become a second query parameter", async () => {
  // Without encoding, `?search=the&other=x` is a search for "the" with an
  // unrelated parameter attached -- a search that runs, returns the wrong
  // things, and gives nothing to indicate it did.
  await actions.searchMessages(
    { commit: jest.fn() },
    { room: 7, term: "the&other=x" }
  );

  const url = mockGet.mock.calls[0][0];
  expect(url).toContain("%26");
  expect(url.split("?").length).toBe(2); // one `?`, so one query string
});

test("results land in their own map, never in the thread", async () => {
  const commit = jest.fn();

  await actions.searchMessages({ commit }, { room: 7, term: "ticket" });

  expect(commit).toHaveBeenCalledWith("SET_SEARCH_RESULTS", [
    found(90, "the ticket is booked")
  ]);
  // The assertion this file exists for. Linking results into `roomMessages`
  // would splice ten non-adjacent messages into a conversation and move every
  // message below them -- the exact failure items 71 and 73 spent their
  // reversions on.
  expect(commit.mock.calls.map(([name]) => name)).not.toContain(
    "LINK_MESSAGES_TO_ROOM"
  );
});

test("the results are on screen, and the thread is not", async () => {
  const state = openChat();
  const wrapper = mountChat(state);

  wrapper.setData({ searchTerm: "ticket", searched: true });
  state.searchResults = { 90: found(90, "the ticket is booked") };
  await wrapper.vm.$nextTick();

  expect(wrapper.text()).toContain("the ticket is booked");
  expect(wrapper.text()).not.toContain("in the thread");
});

test("closing the search puts the thread back", async () => {
  const state = openChat();
  const wrapper = mountChat(state);
  wrapper.setData({ searchTerm: "ticket", searched: true });
  state.searchResults = { 90: found(90, "the ticket is booked") };
  await wrapper.vm.$nextTick();

  wrapper.vm.closeSearch();
  await wrapper.vm.$nextTick();

  expect(wrapper.text()).toContain("in the thread");
  expect(wrapper.text()).not.toContain("the ticket is booked");
  expect(state.searchResults).toEqual({});
});

test("changing room drops the results rather than showing them in the wrong chat", async () => {
  // `searchResults` is one map for the whole app, and `selectedRoom` is the
  // only thing that says which chat is on screen. Results left behind would
  // render in the room the user just clicked into -- and nothing downstream
  // could catch it, because a result carries its own `room` and nothing checks
  // it against the selection.
  const state = openChat();
  state.searchResults = { 90: found(90, "the ticket is booked") };
  const wrapper = mountChat(state);
  wrapper.setData({ searched: true });
  await wrapper.vm.$nextTick();

  state.selectedRoom = 8;
  await wrapper.vm.$nextTick();

  expect(wrapper.vm.searchResults).toEqual([]);
});

test("an empty search does not go to the server", async () => {
  const state = openChat();
  const wrapper = mountChat(state);
  wrapper.setData({ searchTerm: "   " });

  wrapper.vm.search();

  // `dispatch`, not `mockGet`. `$store.dispatch` is a mock in this harness, so a
  // search that got as far as the action would never reach `mockGet` -- the
  // assertion below would pass with the guard deleted, which is exactly what
  // reversion R5 showed before this line existed.
  expect(wrapper.vm.$store.dispatch).not.toHaveBeenCalled();
  expect(mockGet).not.toHaveBeenCalled();
});
