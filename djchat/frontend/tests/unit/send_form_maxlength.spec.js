/* eslint-env jest */
/**
 * A message you can type but can never send.
 *
 * `chat.models.Message.body` is a `TextField(max_length=500)`. The database
 * ignores `max_length` on a `TextField`, but DRF's `get_field_kwargs` copies
 * it onto the serializer field anyway, so `CreateMessageSerializer` validates
 * `body` as `CharField(max_length=500)`. Measured against a live request: 500
 * characters is a 201, 501 is a 400.
 *
 * The input had no `maxlength` and no way to show an error, so a 501-character
 * message was fully typable and fully unsendable:
 *
 *   1. Type or paste 501 characters, press Enter. `sendMessage` commits the
 *      optimistic bubble and clears the box.
 *   2. The POST comes back 400. `store/actions.js` commits
 *      `REMOVE_FAILED_MESSAGE`, and the catch puts the text back.
 *   3. The bubble blinks out, the text reappears, and nothing says why. Pressing
 *      Enter again mints a new `front_key` and fails identically -- there is no
 *      action the user can take that sends it.
 *
 * This is the same defect the project already fixed once, for the other
 * length-limited field: `UserProfile.vue:113-118` added `maxTagline: 1024` with
 * a comment naming this exact failure ("a paste over the limit came back as a
 * 400 that nothing displayed"). `body` never got the same treatment.
 *
 * The Django half is `test_the_client_cap_matches_the_body_limit` in
 * `chat/_tests/test_message_api.py`, which pins the number this one reads
 * against `Message._meta`. This file cannot: jest has no Django.
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

test("the input will not accept a message the server will refuse", () => {
  const wrapper = mountForm();

  // The attribute, not the enforcement. jsdom does not reliably clamp a
  // programmatic `element.value =` to `maxlength`, so a test that typed 501
  // characters in would be testing jsdom rather than the component. What the
  // browser honours is the attribute being present and bound to the number the
  // server actually enforces -- and that number is the Django test's job.
  // `textarea`, not `input`: the composer was converted so a message can span
  // more than one line (item 75), and this selector was the one thing in the
  // suite that named the old tag.
  const limit = wrapper.find("textarea").attributes("maxlength");

  expect(limit).toBeDefined();
  expect(Number(limit)).toBe(wrapper.vm.maxBody);
});

test("a message at the limit is still sendable", () => {
  // The cap must not cost the user the boundary itself. If `maxBody` were off by
  // one in the strict direction, the last message the server would have
  // accepted becomes unsendable, and nothing else would show it.
  const wrapper = mountForm();
  wrapper.setData({ body: "x".repeat(wrapper.vm.maxBody) });

  wrapper.vm.sendMessage();

  expect(wrapper.vm.$store.dispatch).toHaveBeenCalledWith(
    "sendMessage",
    expect.objectContaining({ body: "x".repeat(wrapper.vm.maxBody) })
  );
});
