/* eslint-env jest */
/**
 * The message pane, rendered with the store's own starting values.
 *
 * `Rooms.vue:13` mounts `<messages-section>` unconditionally - the only gate on
 * it is `Home.vue:47`'s `width >= 768`, which is about the viewport and knows
 * nothing about the selection. So on a desktop-width screen this component
 * renders before the user has clicked anything, when `state.js:3,6` still read
 * `selectedRoom: null` and `rooms: {}`.
 *
 * The header then reads `state.rooms[null].group_name`, which is
 * `undefined.group_name`, and the render throws. Vue aborts the whole subtree on
 * a render error, so what the user gets is a pane containing only the outer
 * `<div class="relative">` - no header, no messages, no send form.
 *
 * The component is not wrong to read through `rooms[selectedRoom]`. Every writer
 * of the selection guarantees the room is there: `UsersSection.vue:100` selects
 * an id it just read out of `state.rooms`, and `App.vue:52-54` clears the
 * selection before `REMOVE_ROOM` deletes it. `ContactProfile.vue:196` records the
 * invariant in as many words. The unguarded read is a deliberate choice about a
 * state the app never enters - and `null` is the one state it does enter, on
 * every load, which the invariant never covered.
 *
 * This was invisible for two independent reasons, and both are worth naming. No
 * spec rendered the component without a selection: `room_paging_race.spec.js`
 * sets `selectedRoom = 8` directly on the mock store, bypassing the only two
 * writers, and its `rooms` has no key 8 - so *it* has been throwing on every
 * run and reporting PASS. And a render `TypeError` does not fail the test that
 * caused it; Vue logs it and carries on. Both are why this is pinned here rather
 * than left to be found again by a user.
 */
import { mount } from "@vue/test-utils";
import MessagesSection from "@/components/messages/MessagesSection.vue";

const INITIAL_STATE = {
  selectedRoom: null,
  roomMessages: {},
  unreadMessages: {},
  rooms: {},
  users: {},
  allReceived: {},
  allRead: {}
};

const mountSection = state =>
  mount(MessagesSection, {
    mocks: {
      $store: {
        state,
        commit: jest.fn(),
        // Never settles: `mounted()`/watchers must not fetch anything here.
        dispatch: jest.fn(() => new Promise(() => {}))
      }
    }
  });

beforeAll(() => {
  // jsdom has no layout, so `Element.scrollTo` is absent and `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

test("the pane renders before any room is selected, which is every load", () => {
  const wrapper = mountSection({ ...INITIAL_STATE });

  // Read directly rather than trusting the render. Vue routes a render error to
  // `console.error` and mounts an empty subtree, so "the DOM looks wrong" is a
  // weaker statement than "this threw" - and it is the throw that is the bug.
  expect(wrapper.vm.getColor).toEqual({
    red: expect.any(Number),
    green: expect.any(Number),
    blue: expect.any(Number)
  });

  // ...and the rest of the subtree survives, which is the user-visible half.
  // Before the fix this was `<div class="relative">` and nothing under it.
  expect(wrapper.find(".messages-section").exists()).toBe(true);
});

test("a selected room still renders its name and avatar", () => {
  // The other half. A fix that always renders the empty string passes the test
  // above and breaks the app, which is the way this kind of guard usually goes.
  const wrapper = mountSection({
    ...INITIAL_STATE,
    selectedRoom: 7,
    rooms: { 7: { id: 7, group_name: "Bob" } }
  });

  expect(wrapper.text()).toContain("Bob");
  expect(wrapper.find(".avatar-circle").text()).toBe("B");
});