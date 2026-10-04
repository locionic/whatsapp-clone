/* eslint-env jest */
/**
 * A message you cannot break across lines.
 *
 * `SendForm.vue:5-14` was an `<input type="text">` with `@keyup.enter`. Two
 * consequences, and only one of them is a keypress:
 *
 *   1. A single-line input cannot represent a newline, so there was no way to
 *      compose a message over more than one line *at all*.
 *   2. Every Enter sent, including Enter held with Shift, which is the one
 *      combination that should have meant "break the line".
 *
 * This matters more here than it would in a smaller app because the limit is
 * the app's own: `maxBody` is 500 (`SendForm.vue:48`, and `send_form_maxlength.
 * spec.js` pins it against Django's `Message.body max_length`). So the composer
 * is offered 500 characters and could hold about one line of them.
 *
 * **What these tests do and do not claim.** They do not assert that Shift+Enter
 * inserts a newline - that is the browser's default action for a `textarea` and
 * jsdom does not perform it, so asserting it here would be testing jsdom. What
 * the component owns is narrower and is what it checks: the composer is an
 * element that *can* hold a newline, plain Enter sends, and Shift+Enter does
 * not. The pair of Enter tests is what makes that last one non-vacuous.
 *
 * The fix is two modifiers and no new code. `.exact` is Vue's guard: it
 * compiles to `if ($event.shiftKey) return null`, so a shifted keypress never
 * reaches the handler and the browser's own newline insertion stands.
 * `.prevent` is what stops that newline on an *un*shifted Enter -- hence
 * `keydown` rather than the `keyup` this used to be, since the newline is
 * inserted on keydown and a keyup handler would let it appear for a frame
 * before the send cleared it.
 */
import { mount } from "@vue/test-utils";
import SendForm from "@/components/SendForm.vue";

function mountForm() {
  return mount(SendForm, {
    mocks: {
      $store: {
        state: { selectedRoom: 7 },
        commit: jest.fn(),
        dispatch: jest.fn(() => Promise.resolve({ data: { id: 1 } }))
      }
    }
  });
}

/**
 * Whichever element is the composer today, found by tag rather than by class or
 * ref. Deliberately *not* `find("textarea")`: a selector that only matches after
 * the fix makes the behaviour tests throw "cannot call trigger on an empty
 * Wrapper" beforehand, so they would be reporting the missing element instead of
 * the defect. These three have to be able to fire against the old `<input>` and
 * fail because `dispatch` was called when it should not have been.
 */
const composer = wrapper => wrapper.find("textarea, input");

test("the composer can hold a line break", () => {
  // The tag is the assertion, not an implementation detail: "can hold more than
  // one line" is not a property any single `<input type=...>` has. Changing the
  // tag is the change being pinned, so this one *does* look for the new element
  // specifically and is expected to fail before the fix.
  expect(
    mountForm()
      .find("textarea")
      .exists()
  ).toBe(true);
});

test("Enter sends", () => {
  // The guard on the Shift+Enter test below. `.exact` is the whole fix, and
  // this is what would catch a guard written so tightly that nothing sends.
  const wrapper = mountForm();
  wrapper.setData({ body: "first line" });

  composer(wrapper).trigger("keydown.enter");

  expect(wrapper.vm.$store.dispatch).toHaveBeenCalledWith(
    "sendMessage",
    expect.objectContaining({ body: "first line" })
  );
});

test("Shift+Enter does not send", () => {
  // The defect. A newline cannot be typed and Shift+Enter sends anyway, so
  // there is no combination available to the user that does the obvious thing.
  const wrapper = mountForm();
  wrapper.setData({ body: "first line" });

  composer(wrapper).trigger("keydown.enter", { shiftKey: true });

  expect(wrapper.vm.$store.dispatch).not.toHaveBeenCalled();
});

test("Shift+Enter leaves what was typed alone", () => {
  // The other half, and the part that would be missed by asserting only the
  // dispatch. A guard that cleared the box before bailing would satisfy the
  // test above while eating the message the user was in the middle of writing
  // -- which is a worse bug than the one being fixed.
  const wrapper = mountForm();
  wrapper.setData({ body: "first line" });

  composer(wrapper).trigger("keydown.enter", { shiftKey: true });

  expect(wrapper.vm.body).toBe("first line");
});

test("the 500-character limit still applies to the composer", () => {
  // The cap is unchanged by this, and `send_form_maxlength.spec.js` pins the
  // number against the server. Repeating the attribute here is only so a
  // textarea conversion that quietly dropped `maxlength` - the whole reason
  // that file exists - cannot pass unnoticed by editing its selector away.
  expect(composer(mountForm()).attributes("maxlength")).toBeDefined();
});
