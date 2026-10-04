/* eslint-env jest */
/**
 * What "Delete chat" tells you when it cannot delete the chat.
 *
 * The bug this pins: `deleteChat` committed the clear, dispatched the delete
 * bare, and closed the profile panel on the very next line - unconditionally,
 * before the server had been asked. So a delete that failed was completely
 * invisible: the chat closed, the panel slid away, the room stayed in the
 * sidebar, and nothing said any of that had happened. No error, no rejection
 * anywhere.
 *
 * The panel closing is the part that matters. Even with a message added, the
 * natural place to render it is inside this panel - and the panel was closed on
 * click, so anything rendered here would slide off screen unread. That is why
 * the fix moves the close into the success path rather than adding a catch and
 * leaving the close where it was.
 */
import { shallowMount } from "@vue/test-utils";
import ContactProfile from "@/components/profiles/ContactProfile.vue";

const GENERIC = "The chat could not be deleted. Please try again.";

const STORE = {
  width: 1200,
  selectedRoom: 7,
  rooms: { 7: { id: 7, group_profile: { username: "Bob", tagline: "" } } },
  roomActivity: null
};

function mountProfile({ deleteRoom = () => Promise.resolve() } = {}) {
  const dispatch = jest.fn(action =>
    action === "deleteRoom" ? deleteRoom() : Promise.resolve()
  );
  const emit = jest.fn();
  const wrapper = shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: { state: { ...STORE }, dispatch, commit: jest.fn() }
    }
  });
  wrapper.vm.$emit = emit;
  return { wrapper, dispatch, emit };
}

test("a failed delete says so instead of closing the panel", async () => {
  const { wrapper, emit } = mountProfile({
    deleteRoom: () => Promise.reject(new Error("500"))
  });

  await wrapper.vm.deleteChat();

  expect(wrapper.vm.error).toBe(GENERIC);
  // The close is what made the failure unreportable, so it has to move.
  expect(emit).not.toHaveBeenCalled();
  // ...and the message has to be on screen, not just in a field. A "fix" that
  // set `error` while the panel slid away would pass the line above.
  expect(wrapper.text()).toContain(GENERIC);
});

test("a successful delete still closes the panel", async () => {
  const { wrapper, emit } = mountProfile();

  await wrapper.vm.deleteChat();

  expect(wrapper.vm.error).toBe("");
  expect(emit).toHaveBeenCalledWith("toggleRightSidenav");
});

test("a successful delete still clears the open chat", async () => {
  // Same move as the close: on success the end state has to be what it always
  // was, selection cleared and panel shut.
  const commit = jest.fn();
  const wrapper = shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: {
        state: { ...STORE },
        dispatch: () => Promise.resolve(),
        commit
      }
    }
  });

  await wrapper.vm.deleteChat();

  expect(commit).toHaveBeenCalledWith("SET_SELECTED_ROOM", null);
});

test("a failed delete leaves the chat open and selected", async () => {
  // Nothing needs undoing on failure - the room is still there and still
  // clickable - but the chat must not have been closed out from under a delete
  // that never happened.
  const commit = jest.fn();
  const wrapper = shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: {
        state: { ...STORE },
        dispatch: () => Promise.reject(new Error("500")),
        commit
      }
    }
  });

  await wrapper.vm.deleteChat();

  expect(commit).not.toHaveBeenCalled();
});

test("retrying clears the error once it works", async () => {
  // The row stays clickable after a failure, which is the whole recovery path.
  // A stale error left on screen after a successful retry would claim the chat
  // still could not be deleted.
  let attempt = 0;
  const { wrapper } = mountProfile({
    deleteRoom: () =>
      ++attempt === 1 ? Promise.reject(new Error("500")) : Promise.resolve()
  });

  await wrapper.vm.deleteChat();
  expect(wrapper.vm.error).toBe(GENERIC);

  await wrapper.vm.deleteChat();
  expect(wrapper.vm.error).toBe("");
});
