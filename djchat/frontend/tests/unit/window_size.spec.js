/* eslint-env jest */
/**
 * The only live component nothing mounts.
 *
 * `WindowSize` is registered in `App.vue` and every spec that touches `App`
 * uses `shallowMount`, which stubs children out - so its `created()` hook has
 * never run in this suite. It carries logic, which is the line that decides
 * whether untested rendering matters: the rest of the unmounted components
 * (`SuccessAlert`, `InviteFriend`) are one prop and a slot with no logic
 * between them.
 *
 * **`InviteFriend` has since outgrown that sentence, and this entry is where
 * it was found wrong.** `InviteFriend.vue:6` is now a re-emit -
 * `<invite-button @action="$emit('invite-action')" />` - so it is a slot plus a
 * wire, not a slot alone, and a break in it is a button that renders correctly
 * and does nothing. `invite_button_chain.spec.js` mounts it and pins both
 * halves. It is worth saying how the premise was allowed to expire unnoticed:
 * `InviteFriend.vue` reports 100% covered. It has 2 instrumented statements,
 * because a `.vue` template is not in the coverage model at all -- vue-jest
 * compiles it to a generated render function that `babel-plugin-istanbul`
 * never sees. So the file that grew logic nobody looked at was also the file
 * that could not report having grown it. The reasoning here was sound and its
 * premise was simply not checked. `SuccessAlert` was not re-examined, and this
 * file does not now claim it has no logic.
 *
 * What it feeds is not cosmetic. `Home.vue` gates the two panes on it -
 * `v-if="width < 768"` for the sidebar, `v-if="width >= 768"` for `<rooms>` -
 * so `state.width` decides whether the chat pane exists at all. Item 61's crash
 * was inside that pane and only reachable at desktop width, which makes this
 * gate the switch that put the bug in front of the user.
 *
 * `state.width` starts as `null`, so `null >= 768` is false and the first paint
 * is the narrow layout; `handleResize` commits the real width immediately after,
 * in `created`, which is why the narrow flash is invisible and why the commit
 * being tested is on mount rather than on resize.
 */
import { mount } from "@vue/test-utils";
import WindowSize from "@/components/WindowSize.vue";

const setViewport = (width, height) => {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true
  });
  Object.defineProperty(window, "innerHeight", {
    value: height,
    configurable: true,
    writable: true
  });
};

const setup = () => {
  const commit = jest.fn();
  const wrapper = mount(WindowSize, {
    mocks: { $store: { commit } }
  });
  return { wrapper, commit };
};

test("the store learns the window size on mount, before anything is resized", () => {
  setViewport(1024, 768);

  const { commit } = setup();

  expect(commit).toHaveBeenCalledWith("SET_CURRENT_WIDTH", 1024);
  expect(commit).toHaveBeenCalledWith("SET_CURRENT_HEIGHT", 768);
});

test("a resize follows the window instead of staying at the first value", async () => {
  setViewport(1440, 900);
  const { wrapper, commit } = setup();

  setViewport(600, 500);
  window.dispatchEvent(new Event("resize"));
  await wrapper.vm.$nextTick();

  // Both directions, because a handler that only ever grows is as broken as one
  // that never fires: narrowing past 768 is what hides the chat pane.
  expect(commit).toHaveBeenCalledWith("SET_CURRENT_WIDTH", 600);
  expect(commit).toHaveBeenLastCalledWith("SET_CURRENT_HEIGHT", 500);
  wrapper.destroy();
});

test("the resize listener is the one added, and it goes when the component does", () => {
  const added = jest.spyOn(window, "addEventListener");
  const removed = jest.spyOn(window, "removeEventListener");
  try {
    const { wrapper } = setup();
    const handler = (added.mock.calls.find(call => call[0] === "resize") ||
      [])[1];

    expect(typeof handler).toBe("function");

    wrapper.destroy();

    // Same function, not merely an event of the same name: removing a listener
    // is identity-based, and a typo in `destroyed` or a re-bound method would
    // leave it attached while still looking right here.
    expect(removed).toHaveBeenCalledWith("resize", handler);
  } finally {
    added.mockRestore();
    removed.mockRestore();
  }
});

test("a destroyed component stops committing on resize", () => {
  const added = jest.spyOn(window, "addEventListener");
  try {
    const { wrapper, commit } = setup();
    wrapper.destroy();
    const before = commit.mock.calls.length;

    window.dispatchEvent(new Event("resize"));

    expect(commit.mock.calls.length).toBe(before);
  } finally {
    added.mockRestore();
  }
});
