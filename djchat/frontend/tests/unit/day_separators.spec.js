/* eslint-env jest */
/**
 * Day separators in the thread.
 *
 * Phase 2 item 2, and the reason PLAN.md filed it second rather than first:
 * it turns the thread's single `v-for` into a nested one, and that `:key` is
 * load-bearing for items 71-73. `sidebar_row_identity.spec.js` records what a
 * missing key costs in this codebase -- a wrong field renders, green, in every
 * chat -- so this file spends most of its assertions on the nesting rather than
 * on the dates.
 *
 * The dates themselves were the easy half. Every bubble already renders
 * `{{ time }}` at `hh:MM` (`SentMessage.vue:64`, `ReceivedMessage.vue:46`), so
 * the reader has the information and has to count back through the bubbles to
 * use it.
 *
 * Timestamps are built at midday rather than midnight deliberately. `setDate`
 * moves by calendar day and keeps the clock time, so a message at 12:00 today
 * is unambiguously today in every timezone, including the two hours either side
 * of a DST change where midnight does not exist or occurs twice.
 */
import Vue from "vue";
import dateFormat from "dateformat";
import { mount } from "@vue/test-utils";
import mutations from "@/store/mutations.js";
import MessagesSection from "@/components/messages/MessagesSection.vue";

const at = (daysAgo, minute = 0) => {
  const when = new Date();
  when.setHours(12, minute, 0, 0);
  when.setDate(when.getDate() - daysAgo);
  return when.toISOString();
};

const bubble = (id, body, daysAgo, extra) => ({
  id,
  room: 7,
  body,
  is_owner: false,
  // Each bubble gets its own minute, so two messages in the same day are never
  // also identical in `timestamp`. A fixture where they are cannot tell
  // per-day grouping from per-timestamp grouping -- which is exactly what
  // reversion R2 did at first: it survived, because that fixture's two
  // six-day-old messages shared a timestamp and so shared a group.
  timestamp: at(daysAgo, id * 7),
  front_key: `key-${id}`,
  author: 9,
  all_received: false,
  all_read: false,
  ...extra
});

const openChat = messages =>
  Vue.observable({
    selectedRoom: 7,
    sendingPool: new Map(),
    receivedMessages: {},
    roomMessages: { 7: messages },
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
        commit: (name, payload) => mutations[name](state, payload),
        dispatch: jest.fn(() => new Promise(() => {}))
      }
    }
  });

const headers = wrapper => wrapper.findAll(".day-separator");
const bubbles = wrapper => wrapper.findAll(".received-message");

beforeAll(() => {
  // jsdom has no layout, so `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

test("a day boundary in the thread gets a header", async () => {
  const state = openChat([bubble(1, "yesterday", 1), bubble(2, "today", 0)]);
  const wrapper = mountChat(state);
  await wrapper.vm.$nextTick();

  expect(headers(wrapper)).toHaveLength(2);
  // Which is the point of the feature, and the reason it is not just a date:
  // a message you sent an hour ago is not "October 4th".
  expect(wrapper.text()).toContain("Yesterday");
  expect(wrapper.text()).toContain("Today");
});

test("an older day is named rather than counted back to", async () => {
  const state = openChat([bubble(1, "last week", 6)]);
  const wrapper = mountChat(state);
  await wrapper.vm.$nextTick();

  // Built with the same library the component uses, so this pins the format
  // rather than a locale I guessed.
  expect(wrapper.text()).toContain(dateFormat(at(6), "dddd, mmmm dS"));
  expect(wrapper.text()).not.toContain("Today");
});

test("every message still renders exactly once, in order, across the groups", async () => {
  // The nesting half. A `v-for` inside a `v-for` is where a message quietly
  // stops rendering, and nothing else here would notice.
  const state = openChat([
    bubble(1, "oldest", 6),
    bubble(2, "also six days", 6),
    bubble(3, "yesterday", 1),
    bubble(4, "today", 0),
    bubble(5, "and today", 0)
  ]);
  const wrapper = mountChat(state);
  await wrapper.vm.$nextTick();

  expect(bubbles(wrapper)).toHaveLength(5);
  expect(headers(wrapper)).toHaveLength(3);
  expect(bubbles(wrapper).wrappers.map(w => w.text())).toEqual([
    expect.stringContaining("oldest"),
    expect.stringContaining("also six days"),
    expect.stringContaining("yesterday"),
    expect.stringContaining("today"),
    expect.stringContaining("and today")
  ]);
});

test("a message replaced in place keeps its slot", async () => {
  // Item 73's invariant, at the seam this change touches. The optimistic bubble
  // is committed, then the server's copy *replaces* it in place -- not appended,
  // not re-sorted. If the nested `v-for` lost the inner `:key`, that
  // replacement becomes a patch by index and the thread can end up showing the
  // confirmed message twice, or the clock icon on the wrong bubble.
  const state = openChat([bubble(1, "yesterday", 1)]);
  const inFlight = {
    room: 7,
    body: "hi",
    is_owner: true,
    sending: true,
    timestamp: at(0),
    front_key: "key-mine"
  };
  mutations.LINK_MESSAGES_TO_ROOM(state, [inFlight]);
  mutations.ADD_MESSAGE_TO_SENDING(state, inFlight);

  const wrapper = mountChat(state);
  await wrapper.vm.$nextTick();
  expect(wrapper.findAll(".sent-message")).toHaveLength(1);

  // The server's answer for the same `front_key`.
  mutations.LINK_MESSAGES_TO_ROOM(state, [
    bubble(2, "hi", 0, { is_owner: true, front_key: "key-mine" })
  ]);
  await wrapper.vm.$nextTick();

  expect(wrapper.findAll(".sent-message")).toHaveLength(1);
  expect(wrapper.find(".sent-message").text()).not.toContain("access_time");
  // Two groups still: yesterday's, and today's -- not three.
  expect(headers(wrapper)).toHaveLength(2);
});

test("a room with no messages has no headers", async () => {
  const wrapper = mountChat(openChat([]));
  await wrapper.vm.$nextTick();

  expect(headers(wrapper)).toHaveLength(0);
});

test("search results carry no day headers", async () => {
  // A design decision, pinned because the alternative is a future well-meaning
  // change. Hits are the same messages with most of their neighbours missing,
  // so a date header above one says nothing about the conversation it came from
  // and reads as if it headed the whole thread.
  const state = openChat([bubble(1, "in the thread", 1)]);
  const wrapper = mountChat(state);
  wrapper.setData({ searched: true, searchTerm: "ticket" });
  state.searchResults = { 9: bubble(9, "the ticket is booked", 0) };
  await wrapper.vm.$nextTick();

  expect(wrapper.text()).toContain("the ticket is booked");
  expect(headers(wrapper)).toHaveLength(0);
});
