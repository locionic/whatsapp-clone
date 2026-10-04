/* eslint-env jest */
/**
 * The other half of `LINK_MESSAGES_TO_ROOM`: the branch an *incoming* message
 * takes.
 *
 * Items 71 through 73 all worked the `sendingPool` branch, because that is the
 * one with the optimistic bubble and the reactive-identity problem. Its
 * neighbour has been covered the whole time, but only at the state level:
 * `room_message_order.spec.js` runs all six of its cases against a plain object
 * and its `msg()` fixture carries no `is_owner`, no `author` and no
 * `timestamp`, so it could not have been rendered even if someone had tried.
 *
 * So this is the most basic thing in the app, untested through the screen: the
 * peer you are chatting with types, `models.py:60` group_sends to every
 * participant, `App.vue:57` commits the message, and does it appear?
 */
import Vue from "vue";
import { mount } from "@vue/test-utils";
import mutations from "@/store/mutations.js";
import MessagesSection from "@/components/messages/MessagesSection.vue";

// What the socket carries: `MessageSerializer` output, so `author` is a user
// id rather than a nested object. `ReceivedMessage.vue:47-51` resolves it
// against `state.users` itself, which is why that map is in the fixture below.
const incoming = (id, body) => ({
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
    roomMessages: {},
    unreadMessages: {},
    allReceived: {},
    allRead: {},
    // `/api/v1/rooms/` returns every participant of every room
    // (`roomViews.py:259-265`), so a peer who can message you is in here from
    // the moment the app loads.
    users: { 9: { id: 9, username: "Bob", email: "bob@example.com" } },
    rooms: { 7: { id: 7, group_name: "Bob" } }
  });

const mountChat = state =>
  mount(MessagesSection, {
    mocks: {
      $store: {
        state,
        commit: jest.fn(),
        dispatch: jest.fn(() => new Promise(() => {}))
      }
    }
  });

beforeAll(() => {
  // jsdom has no layout, so `Element.scrollTo` is absent and `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

test("a message from the peer appears while you have the room open", async () => {
  // The room starts with what `/api/v1/rooms/` shipped: one `last_message`.
  const state = openChat();
  mutations.LINK_MESSAGES_TO_ROOM(state, [incoming(1, "are you there")]);
  const wrapper = mountChat(state);
  expect(wrapper.text()).toContain("are you there");

  mutations.LINK_MESSAGES_TO_ROOM(state, [incoming(2, "still there")]);
  await wrapper.vm.$nextTick();

  expect(wrapper.text()).toContain("still there");
  // And it arrives *below* the one before it, not above.
  expect(wrapper.findAll(".received-message").at(1).text()).toContain(
    "still there"
  );
});

test("a message from the peer does not disturb your own", async () => {
  // The other half. The peer typing must not disturb what you have already
  // sent: your bubble keeps its slot and keeps its state, rather than the list
  // being rebuilt around the newcomer.
  const state = openChat();
  mutations.LINK_MESSAGES_TO_ROOM(state, [incoming(1, "hello")]);
  const sent = {
    room: 7,
    body: "hi",
    is_owner: true,
    sending: true,
    timestamp: "2026-01-01T10:00:00Z",
    front_key: "key-mine"
  };
  mutations.LINK_MESSAGES_TO_ROOM(state, [sent]);
  mutations.ADD_MESSAGE_TO_SENDING(state, sent);

  const wrapper = mountChat(state);
  expect(wrapper.findAll(".sent-message")).toHaveLength(1);

  mutations.LINK_MESSAGES_TO_ROOM(state, [incoming(2, "welcome")]);
  await wrapper.vm.$nextTick();

  expect(wrapper.findAll(".sent-message")).toHaveLength(1);
  expect(wrapper.findAll(".received-message")).toHaveLength(2);
  expect(wrapper.find(".sent-message").text()).toContain("hi");
  expect(wrapper.find(".sent-message .material-icons").text()).toBe(
    "access_time"
  );
});

test("only an unread message from the peer posts its read receipt", () => {
  // `ReceivedMessage.created()` -> `markMessageAsRead` is the whole of the
  // other side of the read-receipt axis: opening a chat is what marks the
  // peer's messages read, and it is the one path that does it without you
  // clicking anything. Item 81's sweep found it has no test at all --
  // replacing the membership check with `if (true)` changed nothing in 231
  // specs -- so the sweep would otherwise have been the only evidence.
  //
  // Faked timers because the dispatch sits behind a 100ms timeout there, to
  // stay clear of `markRoomAsRead` firing on the same tick. Both messages are
  // in the thread and only one is in `unreadMessages`, which is what the check
  // reads; `unread_axis.spec.js` pins that map's message-id -> room-id shape.
  jest.useFakeTimers();
  try {
    const state = openChat();
    mutations.LINK_MESSAGES_TO_ROOM(state, [
      incoming(1, "already read"),
      incoming(2, "not read yet")
    ]);
    state.unreadMessages[2] = 7;

    const wrapper = mountChat(state);
    jest.advanceTimersByTime(100);

    const receipted = wrapper.vm.$store.dispatch.mock.calls
      .filter(([name]) => name === "markMessageAsRead")
      .map(([, id]) => id);
    expect(receipted).toEqual([2]);
  } finally {
    jest.useRealTimers();
  }
});