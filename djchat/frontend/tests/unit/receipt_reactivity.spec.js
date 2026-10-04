/* eslint-env jest */
/**
 * The join between item 66's two halves, which turned out not to be joined.
 *
 * Item 66 pinned the read receipts twice over: `websocket_reconnect.spec.js`
 * asserts App.vue commits `MARK_MESSAGE_ALL_RECEIVED` on the push, and
 * `read_receipts.spec.js` asserts the store override beats the message's own
 * field in the render. Neither spec ever *ran* those mutations -
 * `websocket_reconnect.spec.js` mocks the store, and `read_receipts.spec.js`
 * hands the component a plain object with the key already in it. So the middle of
 * the chain was never executed:
 *
 *     App.vue:66        commit("MARK_MESSAGE_ALL_RECEIVED", message_id)
 *     mutations.js:138  Vue.set(state.allReceived, message_id, true)
 *     SentMessage.vue:23  allReceived[this.message.id] || message.all_received
 *
 * Measured, not assumed. **32 suites, 182 tests, green**, four times over:
 *
 *     Vue.set(state.allReceived, ...) -> state.allReceived[message_id] = true
 *     Vue.set(state.allRead,     ...) -> state.allRead[message_id]     = true
 *
 * In Vue 2, adding a key to an observed object without `Vue.set` is not a
 * reactive change - there is no dependency to notify, because nothing had read
 * that key before it existed. So that substitution produces a store that *holds*
 * the right value and a screen that never updates: every receipt is right in the
 * store, wrong on the display, forever, with nothing logged. Item 66's own header
 * says "both `Vue.set`, so reactive" - that was an assumption written in a
 * comment, and this file turns it into a fact.
 *
 * **Asserting the behaviour, never the call.** These tests do not check that
 * `Vue.set` was invoked; they check that the row's tick changes on screen. That
 * is the discipline items 65 through 68 used, and it is also what makes this a
 * real test rather than a proxy: a future refactor replacing `Vue.set` with
 * `this.$set`, or with a wholesale replacement of the map, would keep the screen
 * correct - and a test watching the call would go red for no reason.
 *
 * `Vue.observable` on the store state, not a plain object, for the reason
 * `contact_profile_stale_error.spec.js` gives: the entire subject here is a
 * *change* to a key that did not exist a moment earlier, and a plain object can
 * never notify anything.
 */
import Vue from "vue";
import { mount } from "@vue/test-utils";
import mutations from "@/store/mutations.js";
import SentMessage from "@/components/messages/SentMessage.vue";

const MESSAGE = {
  id: 7,
  body: "hi",
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  sending: false,
  all_received: false,
  all_read: false
};

const inChat = fields =>
  mount(SentMessage, {
    propsData: { message: { ...MESSAGE, ...fields } },
    mocks: {
      $store: {
        state: Vue.observable({
          allReceived: {},
          allRead: {},
          unreadMessages: {}
        }),
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });

// `read_receipts.spec.js`'s own selector, for the same reason: three
// `.material-icons` in this component and nothing else carries the class.
const icons = wrapper =>
  wrapper.findAll(".material-icons").wrappers.map(one => one.text());

test("a received receipt changes the tick on screen", async () => {
  const wrapper = inChat({ all_received: false });
  expect(icons(wrapper)).toEqual(["done"]);

  mutations.MARK_MESSAGE_ALL_RECEIVED(wrapper.vm.$store.state, 7);
  await wrapper.vm.$nextTick();

  // One tick becomes two. This is the whole feature: the message says "not
  // received" because that is what the fetch said, and the push overrides it.
  expect(icons(wrapper)).toEqual(["done_all"]);
});

test("a read receipt changes the colour on screen", async () => {
  // `all_received: true` in the prop rather than a first mutation, so this test
  // does not stand on the one above. The double tick is already on screen when
  // this starts; the only thing that can change it is `allRead`. With
  // `MARK_MESSAGE_ALL_READ` reverted to a plain assignment the tick stays grey
  // and this goes red while the test above stays green - the two mutations are
  // independently load-bearing, and that pairing is what says neither assertion
  // is standing in for the other.
  const wrapper = inChat({ all_received: true });
  expect(icons(wrapper)).toEqual(["done_all"]);
  expect(wrapper.find(".material-icons").classes()).not.toContain(
    "text-teal-400"
  );

  mutations.MARK_MESSAGE_ALL_READ(wrapper.vm.$store.state, 7);
  await wrapper.vm.$nextTick();

  expect(wrapper.find(".material-icons").classes()).toContain("text-teal-400");
});
