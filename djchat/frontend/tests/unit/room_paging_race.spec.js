/* eslint-env jest */
/**
 * A page of history arriving for a chat you have already left.
 *
 * `noMoreMessages` is component state, not per-room, and it is set from
 * whichever response was in flight. The watcher resets it on every room change,
 * so it looks correct -- right up until you switch rooms while a request is
 * still open, which is the single most ordinary thing a chat user does. Room A's
 * "there is nothing older" then lands and sets the flag for room B, and B's
 * history is capped until you select some third room. Nothing re-arms it in
 * between, and the user cannot tell why scrolling stopped working.
 *
 * The response already says which room it was for -- `room` is in the payload,
 * and `test_recent_per_room_returns_its_room_and_the_message_authors` already
 * asserts it -- so the match costs one comparison.
 */
import { mount } from "@vue/test-utils";
import MessagesSection from "@/components/messages/MessagesSection.vue";

function mountSection() {
  const state = {
    selectedRoom: 7,
    roomMessages: {
      7: [{ id: 1, room: 7, body: "hi", author: 1, timestamp: "2026-01-01" }]
    },
    unreadMessages: {},
    rooms: {
      7: { id: 7, group_name: "Bob" },
      // Room 8 too, because the test below has the user *open* it. The selection
      // is written straight onto the mock store, bypassing the only two writers,
      // so a room the user could not have clicked is a state the store cannot
      // reach -- and this spec was rendering one, which threw inside `getColor`
      // on every run and still reported PASS, because a Vue render error does
      // not fail the test that caused it.
      8: { id: 8, group_name: "Carol" }
    },
    users: { 1: { id: 1, username: "Bob" } },
    allReceived: {},
    allRead: {}
  };

  let answer; // the page request, held open on purpose
  const wrapper = mount(MessagesSection, {
    mocks: {
      $store: {
        state,
        commit: jest.fn(),
        dispatch: jest.fn(() => new Promise(resolve => (answer = resolve)))
      }
    }
  });
  // Hand the pending page back, as the one for `roomId` would arrive.
  const reply = roomId => {
    answer({ data: { messages: [], room: { id: roomId } } });
  };
  return { wrapper, reply };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(() => {
  // jsdom has no layout, so Element.scrollTo is absent; `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

test("a late 'nothing older' does not cap the chat you switched to", async () => {
  const { wrapper, reply } = mountSection();

  wrapper.vm.fetchPastMessages(); // asks about room 7
  wrapper.vm.$store.state.selectedRoom = 8; // ... and the user opens room 8
  reply(7); // room 7's answer finally lands
  await settle();

  expect(wrapper.vm.noMoreMessages).toBe(false);
});

test("a current 'nothing older' does cap its own chat", async () => {
  // The other half: ignoring every response would pass the test above.
  const { wrapper, reply } = mountSection();

  wrapper.vm.fetchPastMessages();
  reply(7);
  await settle();

  expect(wrapper.vm.noMoreMessages).toBe(true);
});
