/* eslint-env jest */
/**
 * A draft you wrote for one chat gets sent to another.
 *
 * `<send-form />` sits at `Rooms.vue:22` with no `:key` and no `v-if`, and
 * `Rooms` is mounted once by `Home.vue:45`, so there is exactly ONE SendForm
 * instance for the whole session. Its `room` watcher is:
 *
 *   room() {
 *     this.timerId = null;
 *   }
 *
 * -- the throttle is cleared, the text is not. `body` is written in four places
 * (`data()`, the v-model, `sendMessage()`, and the refusal catch) and the
 * watcher is none of them, so a draft is not tied to the chat it was typed in.
 *
 * The user-visible path:
 *
 *   1. Bob's chat is open. You type "see you at 8" and do not press Enter.
 *   2. You click Carol in the sidebar. The header, the avatar and
 *      `ContactProfile` all rebind to Carol. `sendMessage` reads `this.room`,
 *      a computed on `$store.state.selectedRoom` (`SendForm.vue:88`), which is
 *      now Carol's id.
 *   3. You press Enter. The POST carries `{room: carol, body: "see you at 8"}`.
 *
 * Bob never sees it. Carol gets a message written for Bob, and it renders green
 * in Carol's thread as an ordinary sent message, so nothing about it looks
 * wrong. Of everything the audit turned up, this is the one that puts text in
 * front of the wrong person.
 *
 * The second test is the same defect reached from the other end: a refusal takes
 * a round trip, and if you switch chats inside that window the catch puts the
 * failed message's text into the *new* chat's box -- so the next Enter sends it
 * to someone who was never in the conversation it belonged to.
 */
import Vue from "vue";
import { mount } from "@vue/test-utils";
import SendForm from "@/components/SendForm.vue";

const BOB = 7;
const CAROL = 8;

function mountForm(refuse = false) {
  // `Vue.observable`, not a plain object: both defects are about a *change* to
  // selectedRoom, and a plain object is not reactive, so the watcher would
  // never fire and these tests would pass against the unfixed code.
  const state = Vue.observable({ selectedRoom: BOB });
  const dispatch = jest.fn(action =>
    action === "sendMessage" && refuse
      ? Promise.reject(new Error("403"))
      : Promise.resolve({ data: { id: 1 } })
  );
  const wrapper = mount(SendForm, {
    mocks: { $store: { state, commit: jest.fn(), dispatch } }
  });
  return { wrapper, dispatch, state };
}

const sentToRooms = dispatch =>
  dispatch.mock.calls
    .filter(([action]) => action === "sendMessage")
    .map(([, payload]) => payload.room);

test("a draft composed for one chat is not sent to another", async () => {
  const { wrapper, dispatch, state } = mountForm();
  wrapper.setData({ body: "see you at 8" });

  // Click Carol. Nothing else in the app distinguishes the two chats from the
  // point of view of the box.
  state.selectedRoom = CAROL;
  await wrapper.vm.$nextTick();

  wrapper.vm.sendMessage();

  expect(sentToRooms(dispatch)).toEqual([]);
  expect(wrapper.vm.body).toBe("");
});

test("a refusal that lands after you switched chats does not come back", async () => {
  const { wrapper, state } = mountForm(true);
  wrapper.setData({ body: "see you at 8" });

  // The send clears the box on its own (`SendForm.vue:82`), so the box is
  // already empty before the room changes. This test therefore does not depend
  // on the watcher clearing anything, and pins the catch's guard on its own.
  wrapper.vm.sendMessage();
  state.selectedRoom = CAROL;
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await Promise.resolve();

  expect(wrapper.vm.body).toBe("");
});

test("a refusal in the same chat still puts the text back", async () => {
  // The guard on the fix above. Reducing the guard to "clear the draft and
  // never restore" would satisfy both tests above and throw away every unsent
  // message -- which is what `failed_send.spec.js` exists to stop, except that
  // it never switches rooms, so it cannot see this.
  const { wrapper } = mountForm(true);
  wrapper.setData({ body: "see you at 8" });

  wrapper.vm.sendMessage();
  await Promise.resolve();
  await Promise.resolve();

  expect(wrapper.vm.body).toBe("see you at 8");
});
