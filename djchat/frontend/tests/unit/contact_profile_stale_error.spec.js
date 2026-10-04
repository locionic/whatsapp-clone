/* eslint-env jest */
/**
 * "Delete chat"'s failure message outlives the chat it is about.
 *
 * Item 19 fixed the failure path: the panel stays open and says what went
 * wrong, and a successful retry clears it. Both of those are about *repeated
 * attempts on the same chat*, which is why the retry case is already covered
 * in `contact_profile_delete.spec.js`.
 *
 * What is not covered is the message following you to a *different* chat. The
 * panel is not re-mounted and not closed when you select another room:
 *
 *   - `Rooms.vue:8` passes `:rightSidenav="rightSidenav"` straight through, and
 *     `ContactProfile` renders from `$store.state.selectedRoom` in every
 *     computed, so the whole panel rebinds to the new room in place.
 *   - `UsersSection.selectRoom` commits `SET_SELECTED_ROOM` and emits
 *     `selected-room`; `Home.vue`'s `openMobileRooms` only opens the mobile
 *     drawer. Nothing flips `rightSidenav`.
 *   - On desktop (`Home.vue:45`, `width >= 768`) the sidebar and the panel are
 *     both on screen, so this is one click, not a gesture.
 *
 * So:
 *
 *   1. Open Bob's profile, press Delete chat, the server refuses. The panel
 *      stays open and reads "The chat could not be deleted. Please try again."
 *   2. Click Carol in the sidebar - same panel, now showing Carol's name,
 *      tagline and activity chart, still carrying step 1's sentence above the
 *      Delete button.
 *
 * The panel has everything else right. `getActivity` explicitly refuses to
 * draw the previous room's bars under the new room's name, and `activityLoaded`
 * is reset when the panel opens - the exact bug this is, found and fixed for the
 * chart one field earlier. The error message is the same class of defect and
 * was missed: it is the only thing on the panel that does not belong to the room
 * currently shown.
 */
import Vue from "vue";
import { shallowMount } from "@vue/test-utils";
import ContactProfile from "@/components/profiles/ContactProfile.vue";

const GENERIC = "The chat could not be deleted. Please try again.";

// `Vue.observable`, not a plain object: the defect is entirely about a *change*
// to `selectedRoom`, and a plain object is not reactive, so a watcher on it
// would never fire and every test here would pass against the unfixed code.
const state = () =>
  Vue.observable({
    width: 1200,
    selectedRoom: 7,
    rooms: {
      7: { id: 7, group_profile: { username: "Bob", tagline: "" } },
      8: { id: 8, group_profile: { username: "Carol", tagline: "" } }
    },
    roomActivity: null
  });

function mountProfile(deleteRoom) {
  const emit = jest.fn();
  const wrapper = shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: {
        state: state(),
        dispatch: jest.fn(action =>
          action === "deleteRoom" ? deleteRoom() : Promise.resolve()
        ),
        commit: jest.fn()
      }
    }
  });
  wrapper.vm.$emit = emit;
  return { wrapper, emit };
}

const refuses = () => Promise.reject(new Error("500"));

test("a failure on one chat is not reported on another", async () => {
  const { wrapper } = mountProfile(refuses);

  await wrapper.vm.deleteChat();
  expect(wrapper.vm.error).toBe(GENERIC);

  // Carol is now the selected room. The panel is still the same open panel.
  wrapper.vm.$store.state.selectedRoom = 8;
  await wrapper.vm.$nextTick();

  expect(wrapper.vm.getRoom.id).toBe(8);
  expect(wrapper.vm.error).toBe("");
  // ...and off the screen, not just out of the field. A fix that cleared the
  // data but left the node would pass the line above.
  expect(wrapper.text()).not.toContain(GENERIC);
});

test("the panel really is still open across the switch", async () => {
  // The precondition, asserted rather than assumed. If selecting a room closed
  // the panel, the test above would be passing for a reason that has nothing to
  // do with the code under test - which is exactly how a green tick outlives
  // the refactor that breaks it.
  const { wrapper, emit } = mountProfile(refuses);
  await wrapper.vm.deleteChat();

  wrapper.vm.$store.state.selectedRoom = 8;
  await wrapper.vm.$nextTick();

  expect(wrapper.props("rightSidenav")).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});

test("a failure on the new chat is still reported", async () => {
  // The guard on the fix. Clearing on room change must not become "never show
  // it" - the message is the only thing the user gets when a delete is refused,
  // and that is the whole of item 19.
  const { wrapper } = mountProfile(refuses);

  wrapper.vm.$store.state.selectedRoom = 8;
  await wrapper.vm.$nextTick();
  await wrapper.vm.deleteChat();

  expect(wrapper.vm.error).toBe(GENERIC);
  expect(wrapper.text()).toContain(GENERIC);
});

test("the same room refreshed in the store does not clear it", async () => {
  // The other guard, and the one that pins *how* the fix is written.
  //
  // `SET_ROOMS` does `Vue.set(state.rooms, element.id, element)`, so every
  // `fetchRooms` replaces each room's entry with a brand-new object literal.
  // `App.vue` dispatches `fetchRooms` on any `update_rooms` push - a peer
  // accepting an invitation, anyone creating a group - so this lands in the
  // middle of an ordinary session.
  //
  // A watcher on `getRoom` re-evaluates here (its dependency is `state.rooms`),
  // gets the *new* object, sees `newValue !== oldValue` and fires - clearing
  // the message off the same room the user is looking at, mid-attempt. Watching
  // the room *id* does not fire at all, because `selectedRoom` did not change.
  //
  // This test is the second isolating mutation. The first version of it set
  // `state.roomActivity` instead, and it passed against *both* watchers: Vue
  // caches computeds, and `getRoom` depends on `selectedRoom` and `state.rooms`
  // rather than on `roomActivity`, so nothing re-evaluated. It was a green tick
  // that proved nothing -- a test that fails to fail is worse than no test.
  const { wrapper } = mountProfile(refuses);
  await wrapper.vm.deleteChat();
  expect(wrapper.vm.error).toBe(GENERIC);

  wrapper.vm.$store.state.rooms = {
    7: { id: 7, group_profile: { username: "Bob", tagline: "" } },
    8: { id: 8, group_profile: { username: "Carol", tagline: "" } }
  };
  await wrapper.vm.$nextTick();

  expect(wrapper.vm.getRoom.id).toBe(7);
  expect(wrapper.vm.error).toBe(GENERIC);
});
