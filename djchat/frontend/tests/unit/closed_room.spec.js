/* eslint-env jest */
/**
 * Fetching older messages with no chat open.
 *
 * The defect: `fetchPastMessages` read `selectedRoom` and used it straight away,
 * and the `selectedRoom` watcher calls it whenever the value changes -- including
 * when it changes to `null`. Three separate places commit `SET_SELECTED_ROOM(null)`
 * on ordinary gestures: `SideRooms.vue:62` (closing the room drawer),
 * `ContactProfile.vue:148` (deleting the chat), and `App.vue:42` (a peer removing
 * you). Every one of them fired `GET /api/v1/messages/null`, which
 * `chat/api/urls.py:9` cannot match -- `messages/<int:room_id>` -- so it 404ed at
 * URL resolution, and the `.catch` on the dispatch then set `fetchingMessages`
 * back to false as if it had all worked out.
 *
 * The guard goes in `fetchPastMessages` rather than in the watcher, because
 * `onScroll` reaches the same method: the scroll pane is still mounted with no
 * room open, and scrolling it fires the same request. A watcher-only guard would
 * leave half the callers broken.
 */
import { mount } from "@vue/test-utils";
import MessagesSection from "@/components/messages/MessagesSection.vue";
import SideRooms from "@/components/rooms/SideRooms.vue";

function mountSection(selectedRoom, roomMessages = {}) {
  // The header reads `$store.state.rooms[selectedRoom].group_name` behind a
  // `v-if="selectedRoom"`, so a selected room has to actually be in `rooms` or
  // the render throws before the refs are set and `mounted()` never gets a
  // scroll pane to work with.
  const rooms = {};
  if (selectedRoom)
    rooms[selectedRoom] = { id: selectedRoom, group_name: "Bob" };

  return mount(MessagesSection, {
    mocks: {
      $store: {
        state: {
          selectedRoom,
          roomMessages,
          unreadMessages: {},
          rooms,
          // The bubbles read all of these: `ReceivedMessage` does
          // `Object.values($store.state.users)`, which throws outright on an
          // absent key, and both bubble types read the tick maps.
          users: { 1: { id: 1, username: "Bob" } },
          allReceived: {},
          allRead: {}
        },
        commit: jest.fn(),
        dispatch: jest.fn(() => Promise.resolve({ data: { messages: [] } }))
      }
    }
  });
}

beforeAll(() => {
  // jsdom has no layout, so Element.scrollTo is absent. `mounted()` reaches it
  // through scrollToBottom.
  window.Element.prototype.scrollTo = jest.fn();
});

test("closing a chat does not ask the server for messages/null", () => {
  const wrapper = mountSection(null);

  // What the watcher does the instant the room is closed: the messages array for
  // a null room is undefined, so it goes looking for history.
  expect(wrapper.vm.messages).toBeUndefined();
  expect(() => wrapper.vm.fetchPastMessages()).not.toThrow();
  expect(wrapper.vm.$store.dispatch).not.toHaveBeenCalled();
});

test("scrolling with no chat open does not either", async () => {
  // onScroll is the other caller, and the scroll pane is still on screen after
  // the room closes. Same request, same 404.
  const wrapper = mountSection(null);
  const scroll = {
    target: { scrollTop: 0, clientHeight: 500, scrollHeight: 900 }
  };

  wrapper.vm.onScroll(scroll);
  await Promise.resolve();

  expect(wrapper.vm.$store.dispatch).not.toHaveBeenCalled();
});

test("an open chat still pages its history", async () => {
  // The other half: a guard that always returned would pass the two above.
  const wrapper = mountSection(7, {
    7: [{ id: 1, room: 7, body: "hi", author: 1, timestamp: "2026-01-01" }]
  });

  wrapper.vm.fetchPastMessages();
  await Promise.resolve();

  expect(wrapper.vm.$store.dispatch).toHaveBeenCalledWith("fetchPastMessages", {
    firstMessageId: 1,
    roomId: 7
  });
});

test("closing the room drawer is what empties the selected room", async () => {
  // This file's header names `SideRooms.vue:62` as one of the three ordinary
  // gestures that commit `SET_SELECTED_ROOM(null)` -- and then pins none of the
  // three, because every case here drives `MessagesSection` directly with
  // `commit: jest.fn()`. The gesture itself was unpinned: item 81's sweep closed
  // the drawer and 231 specs stayed green.
  //
  // It is the only one of the three that is a *gesture* rather than an event.
  // `App.vue:42` is a peer removing you, `ContactProfile.vue:148` is deleting
  // the chat; this is a user closing a panel.
  const wrapper = mount(SideRooms, {
    propsData: { rightSidenav: false, whosWriting: "" },
    // `Rooms` pulls in the whole room list and a `User` row per room under it;
    // nothing under test reads the child.
    stubs: { Rooms: true },
    mocks: { $store: { commit: jest.fn(), dispatch: jest.fn() } }
  });

  // Both edges, because the watcher is on `show` and only a *change* fires it.
  await wrapper.setData({ show: true });
  expect(wrapper.vm.$store.commit).not.toHaveBeenCalled();

  await wrapper.setData({ show: false });
  expect(wrapper.vm.$store.commit).toHaveBeenCalledWith("SET_SELECTED_ROOM", null);
});
