/* eslint-env jest */
/**
 * The only Logout in the app could not be reached from a keyboard.
 *
 * `Menu.vue` opens its dropdown on `@mouseover` and closes it on `@mouseleave`,
 * on a plain `<div>` that is not focusable, wrapping an `<i class="material-icons">`
 * that is not a control. There is no `tabindex`, no `role`, no `aria-expanded`,
 * and the dropdown itself is `v-if`'d - so when it is closed the Logout link does
 * not exist in the DOM to be tabbed to. Nothing opens it without a pointer.
 *
 * It is also the *only* logout: `UsersSection.vue:25` renders it under
 * `width < 768` and `MessagesSection.vue:39` always, so on a phone a hover is
 * the only gesture there is, and on desktop the keyboard path is simply absent.
 *
 * Items 38, 39 and 40 gave the invitation row, the room list and the focus ring
 * a keyboard path. The menu was never in that sweep.
 */
import { shallowMount } from "@vue/test-utils";
import Menu from "@/components/Menu.vue";

function mountMenu() {
  return shallowMount(Menu, { attachTo: document.body });
}

function trigger(wrapper) {
  return wrapper.find("button");
}

function isOpen(wrapper) {
  return wrapper.find(".dropdown-content").exists();
}

test("the trigger is a button, so it is focusable and activatable at all", () => {
  const wrapper = mountMenu();

  // An <i> with an icon font is not a control: no role, no name, not in the
  // tab order. `element.tagName` rather than a selector, so a button somewhere
  // else on the page cannot stand in for the trigger.
  expect(trigger(wrapper).exists()).toBe(true);
  expect(trigger(wrapper).element.tagName).toBe("BUTTON");
});

test("the trigger has an accessible name", () => {
  // The content is an icon font. A screen reader announces the ligature text
  // ("more_vert") or nothing at all, neither of which is a name.
  expect(trigger(mountMenu()).attributes("aria-label")).toBeTruthy();
});

test("the trigger says whether the menu is open", async () => {
  const wrapper = mountMenu();

  expect(trigger(wrapper).attributes("aria-expanded")).toBe("false");

  await trigger(wrapper).trigger("focusin");

  expect(trigger(wrapper).attributes("aria-expanded")).toBe("true");
});

test("it declares what it opens", () => {
  expect(trigger(mountMenu()).attributes("aria-haspopup")).toBeTruthy();
});

test("focusing the trigger reveals the Logout", async () => {
  // The point of the whole thing: `v-if` means a closed menu has no link to
  // tab to, so something has to open it on the way in. Hover cannot do that
  // for a keyboard, and on a touch device it is not a gesture that exists.
  const wrapper = mountMenu();
  expect(isOpen(wrapper)).toBe(false);

  // On the inner `.dropdown`, not on `.menu`: focusin bubbles child to parent,
  // so an event dispatched on the wrapper's root travels outward and never
  // reaches a handler bound below it.
  wrapper.vm.$el.firstChild.dispatchEvent(
    new Event("focusin", { bubbles: true })
  );
  await wrapper.vm.$nextTick();

  expect(isOpen(wrapper)).toBe(true);
  expect(wrapper.text()).toContain("Logout");
});

test("moving focus from the trigger to the link keeps the menu open", async () => {
  // The trap in the obvious fix. `focusout` fires for the button too, so
  // closing on it snaps the menu shut the instant you tab off the trigger
  // onto the only link it contains - the keyboard path dies one step in.
  //
  // Dispatched as a real FocusEvent off the trigger rather than by calling the
  // handler: calling `onFocusOut` directly passes even when the template binds
  // `@focusout="showContext = false"`, because the method is still on the vm
  // either way. That version of this test survived the very mutation it exists
  // to catch - it pinned the method and not the wiring.
  const wrapper = mountMenu();
  await wrapper.setData({ showContext: true });

  const link = wrapper.find(".dropdown-content a");
  trigger(wrapper).element.dispatchEvent(
    new FocusEvent("focusout", { bubbles: true, relatedTarget: link.element })
  );

  expect(wrapper.vm.showContext).toBe(true);
});

test("focus leaving the menu entirely closes it", () => {
  const wrapper = mountMenu();
  wrapper.vm.showContext = true;

  trigger(wrapper).element.dispatchEvent(
    new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })
  );

  expect(wrapper.vm.showContext).toBe(false);
});

test("Escape closes it", () => {
  const wrapper = mountMenu();
  wrapper.vm.showContext = true;

  // `keyCode`, and no `key`: Vue 2's built-in key modifiers prefer the
  // hyphenated `key` whenever it is non-empty, comparing it against the
  // built-in name `esc` - so "Escape" does not match `.esc` and the handler
  // silently never fires. A real browser sends `keyCode` too; jsdom's
  // KeyboardEvent constructor ignores it in the init dict, hence defineProperty.
  const escape = new KeyboardEvent("keydown", { bubbles: true });
  Object.defineProperty(escape, "keyCode", { value: 27 });
  // On the inner `.dropdown` again - keydown bubbles upward, so an event on
  // the root never reaches a handler bound below it.
  wrapper.vm.$el.firstChild.dispatchEvent(escape);

  expect(wrapper.vm.showContext).toBe(false);
});

test("hover still opens it", async () => {
  // Not a keyboard test. This is the path the menu had before, and a fix that
  // traded it for the keyboard would be a regression, not a repair.
  const wrapper = mountMenu();

  wrapper.vm.$el.firstChild.dispatchEvent(
    new MouseEvent("mouseover", { bubbles: true })
  );
  await wrapper.vm.$nextTick();

  expect(isOpen(wrapper)).toBe(true);
});

test("there is exactly one logout, and it is still there", async () => {
  // Opened first, deliberately: with `v-if` a closed menu has no link in the
  // DOM at all, so counting anchors on a closed menu would pass on a menu that
  // had lost its contents entirely - including the current, broken one.
  const wrapper = mountMenu();
  await wrapper.setData({ showContext: true });

  expect(wrapper.findAll(".dropdown-content a").length).toBe(1);
});
