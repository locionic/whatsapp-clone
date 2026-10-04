/* eslint-env jest */
/**
 * Saving your own profile.
 *
 * The bug this pins: `patchUserProfile` caught a failed PATCH and only
 * `console.log`ged it. The button re-enabled, no alert appeared, and the bio the
 * user had just written stayed in the box looking saved. The reachable trigger
 * was the textarea having no `maxlength` -- `tagline` is `max_length=1024`, so a
 * long paste came back 400 and vanished.
 *
 * `mount`, not `shallowMount`: the copy the user reads lives inside
 * SuccessAlert, and a stub would leave "not saved" unassertable.
 */
import { mount } from "@vue/test-utils";
import UserProfile from "@/components/profiles/UserProfile.vue";

function mountWith(dispatch) {
  return mount(UserProfile, {
    propsData: { leftSidenav: true },
    mocks: {
      $store: {
        state: { userProfile: { username: "alice", tagline: "old bio" } },
        dispatch: dispatch
      }
    }
  });
}

function saving(wrapper) {
  wrapper.find("button[type='button']").trigger("click");
  return wrapper.vm.$nextTick();
}

test("a save that fails says so", async () => {
  const dispatch = jest.fn(() => Promise.reject(new Error("400")));
  const wrapper = mountWith(dispatch);

  await saving(wrapper);
  // Two ticks: the click handler is async, so the catch runs after the first.
  await wrapper.vm.$nextTick();

  expect(dispatch).toHaveBeenCalledWith("patchUserProfile", {
    tagline: wrapper.vm.tagline
  });
  expect(wrapper.find(".success-alert").exists()).toBe(true);
  expect(wrapper.text()).toContain("not saved");
  // Red, not the success green -- the two states must not look alike. The
  // colour is on the inner banner; the component root only carries `m-3`.
  expect(wrapper.find(".success-alert > div").classes()).toContain(
    "text-red-900"
  );
});

test("a save that works does not claim to have failed", async () => {
  const dispatch = jest.fn(() => Promise.resolve());
  const wrapper = mountWith(dispatch);

  await saving(wrapper);
  await wrapper.vm.$nextTick();

  expect(wrapper.find(".success-alert").exists()).toBe(true);
  expect(wrapper.text()).toContain("successfully updated");
  expect(wrapper.text()).not.toContain("not saved");
});

test("neither alert is up before anything is saved", () => {
  // Otherwise the banner is just always on screen and says nothing about
  // whether this save worked.
  const wrapper = mountWith(jest.fn());

  expect(wrapper.find(".success-alert").exists()).toBe(false);
});

test("the textarea cannot be given more than the server accepts", () => {
  // max_length=1024 on users.models.CustomUser.tagline. Without this the input
  // takes a long paste, the PATCH 400s, and -- before the error banner -- the
  // user was told nothing.
  const wrapper = mountWith(jest.fn());

  expect(wrapper.vm.maxTagline).toBe(1024);
  expect(wrapper.find("textarea").attributes("maxlength")).toBe("1024");
});

test("the save button is re-enabled after a failure", async () => {
  // Otherwise a single rejected save leaves the profile permanently uneditable.
  const dispatch = jest.fn(() => Promise.reject(new Error("400")));
  const wrapper = mountWith(dispatch);

  await saving(wrapper);
  await wrapper.vm.$nextTick();

  expect(wrapper.vm.isPatching).toBe(false);
  expect(wrapper.find("textarea").attributes("disabled")).toBeUndefined();
});
