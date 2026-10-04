/* eslint-env jest */
/**
 * The "someone is typing" indicator on a room row.
 *
 * `User.vue` subscribes to the EventBus in `created()`:
 *
 *     EventBus.$on("writing", data => {
 *       if (this.room.id === data.room_id) {
 *         let user = this.$store.state.users[data.user_id];
 *         this.whosWriting = user.username;
 *
 * Two defects, one subscription.
 *
 * 1. It is never removed. `UsersSection` renders one `User` per room under a
 *    `v-for` keyed by id, so every room that is added and then removed
 *    destroys a `User` -- and leaves its listener subscribed, holding the whole
 *    destroyed component. Nothing in the tree calls `$off`; the only cleanup in
 *    the codebase is `WindowSize`'s resize listener, so the pattern was known
 *    here and simply not applied.
 *
 * 2. `user.username` is read without a guard, and `state.users` is empty for the
 *    first moments of a session: the socket connects before the first fetch
 *    resolves (items 16 and 20), so a peer who starts typing while you are still
 *    loading arrives as a `writing` push naming a user the store has not seen.
 *    That is a TypeError thrown inside a WebSocket event handler -- it escapes
 *    to the console with nothing on screen, and under node it takes the process
 *    down, which is how item 10 was found.
 */
import Vue from "vue";
import { mount } from "@vue/test-utils";
import { EventBus } from "@/eventBus";
import User from "@/components/users/User.vue";

const ROOM = {
  id: 7,
  group_name: "Bob",
  last_activity: "2026-01-01T10:00:00Z"
};

const STATE = () => ({
  allReceived: {},
  allRead: {},
  roomMessages: {},
  unreadMessages: {},
  users: {}
});

function mountUser(state = STATE()) {
  return mount(User, {
    propsData: { room: ROOM },
    mocks: { $store: { state, dispatch: jest.fn(), commit: jest.fn() } }
  });
}

// The real `$off`, bound before it is replaced. Spying on it is the point --
// the component has to give the subscription back, not merely appear to -- so
// the spy must still *do* the unsubscribing. `jest.fn(jest.fn())` does not:
// the inner mock is a no-op, which makes the spy record the call while nothing
// is actually deregistered.
const realOff = EventBus.$off.bind(EventBus);

// Vue catches an error thrown in an event handler, logs it and carries on, so
// `.not.toThrow()` on the `$emit` sees nothing: the first version of this test
// passed straight through the TypeError it was written to catch. `errorHandler`
// is where the caught error actually goes, so that is what has to be asserted.
const errors = [];

beforeEach(() => {
  errors.length = 0;
  Vue.config.errorHandler = reason => errors.push(reason);
  EventBus.$off = jest.fn(realOff);
});

afterEach(() => {
  // The real one, not the spy: tests that mount a row and do not destroy it
  // would otherwise leave a live listener subscribed to the shared singleton.
  realOff("writing");
  Vue.config.errorHandler = undefined;
});

test("a writing push for an unknown user does not throw", () => {
  // The load-race half. `state.users` is still empty, which is exactly what it
  // is for the first seconds of every session.
  const wrapper = mountUser();

  EventBus.$emit("writing", { user_id: 99, room_id: 7 });

  expect(errors).toEqual([]);
  expect(wrapper.vm.whosWriting).toBe("");
});

test("a writing push for a known user still shows the name", () => {
  // The guard above must not cost the feature: showing the name is the whole
  // point of the indicator, and "never throw" is trivially satisfiable by never
  // showing anything at all.
  const state = STATE();
  state.users[99] = { id: 99, username: "carol" };
  const wrapper = mountUser(state);

  EventBus.$emit("writing", { user_id: 99, room_id: 7 });

  expect(wrapper.vm.whosWriting).toBe("carol");
});

test("a push for a different room is ignored", () => {
  const state = STATE();
  state.users[99] = { id: 99, username: "carol" };
  const wrapper = mountUser(state);

  EventBus.$emit("writing", { user_id: 99, room_id: 8 });

  expect(wrapper.vm.whosWriting).toBe("");
});

test("a removed room row takes its listener with it", () => {
  // The leak. `UsersSection` destroys a `User` every time a room goes away, and
  // every one of those used to leave a live listener holding a dead component.
  const state = STATE();
  state.users[99] = { id: 99, username: "carol" };
  const wrapper = mountUser(state);

  wrapper.destroy();

  expect(EventBus.$off).toHaveBeenCalledWith("writing", expect.any(Function));

  // ...and the listener really is gone, not merely deregistered: emitting after
  // the destroy must not touch the dead instance.
  EventBus.$emit("writing", { user_id: 99, room_id: 7 });
  expect(wrapper.vm.whosWriting).toBe("");
});
