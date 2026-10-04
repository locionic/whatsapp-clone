/* eslint-env jest */
/**
 * The other half of a sidebar row: what was said in it.
 *
 * `User.vue:77` renders the room's last message through a truncation helper, and
 * `:32`/`:38` decide whether that preview or a typing indicator occupies the
 * slot. Four mutations, all green before this file:
 *
 *     :77   truncateString(lastMessage.body, 35)  ->  lastMessage.body
 *     :77   ... 35  ->  ... 10
 *     :114  return str.slice(0, num) + "..."      ->  return str.slice(0, num)
 *     :32   v-if="whosWriting"                    ->  v-if="false"
 *
 *     30 suites, 170 tests, green, four times over.
 *
 * So the row could show a 400-character wall of text where a one-line preview
 * belongs, or a tenth of every message, with no ellipsis to say it had been cut,
 * or a peer typing invisibly *underneath* the message they were replying to.
 * None of it is visible in any existing test, and it never has been: every
 * `User.vue` fixture in the suite - `read_receipts.spec.js:60`,
 * `keyboard_reach.spec.js:25`, `user_writing_listener.spec.js:36` - carries
 * `body: "hi"`. Two characters, so the truncation branch has never executed
 * once. `truncateString` appears in `User.vue` and nowhere else in `src/` or
 * `tests/`: no other component truncates, so there is no sibling test standing in
 * for it.
 *
 * **What is already covered, and is not re-tested here.** Which message the
 * preview shows depends on the store holding each room's messages oldest-first,
 * because `lastMessage` (:159) takes `roomMessages[length - 1]`.
 * `room_message_order.spec.js` pins that order, by `front_key`, and does it
 * properly - the bug it was written for was two endpoints appending in opposite
 * directions, so the newest landed *first*. That half needs no second assertion.
 * This file is only about what happens to the body once it has been chosen.
 *
 * The cap is hardcoded here rather than read from the component because there is
 * nothing to read: the `35` is an inline literal in the template at :77, not a
 * named constant. That is worth saying out loud - `send_form_maxlength.spec.js`
 * binds to its component's constant precisely because there is one, and if this
 * ever becomes a `maxLength` in `data()` the binding becomes available and this
 * line should change with it.
 */
import { mount } from "@vue/test-utils";
import User from "@/components/users/User.vue";

// The cap, as `User.vue:77` spells it.
const CAP = 35;

const message = (body, id = 7) => ({
  id,
  body,
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  sending: false,
  all_received: false,
  all_read: false
});

// The same three-field room fixture `sidebar_row_identity.spec.js` uses, for the
// same reason: `group_name` is dereferenced unguarded at :20 and in `getColor`,
// and `last_activity` goes through `dateFormat` at :153.
const ROOM = {
  id: 7,
  group_name: "Bob",
  last_activity: "2026-01-01T10:00:00Z"
};

const row = (messages, state = {}) =>
  mount(User, {
    propsData: { room: ROOM },
    mocks: {
      $store: {
        state: {
          users: {},
          allReceived: {},
          allRead: {},
          roomMessages: { 7: messages },
          unreadMessages: {},
          ...state
        },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });

// The row's preview text, and nothing else that happens to sit in the same
// slot. `.body-section` (:28) holds the typing indicator (:33) *or* the preview
// (:76), and for a message you sent it also holds the read-receipt icons -
// `<i class="material-icons">access_time|done_all|done</i>`, whose text is what
// the icon font would draw. So the badge is excluded by class rather than by
// relying on `unreadMessages` being empty, and the receipt `<i>`s drop out
// because they are not `<p>`s. Trimmed, because the flex wrapper contributes
// whitespace around the `<p>`.
const preview = wrapper =>
  wrapper
    .find(".body-section p:not(.circle)")
    .text()
    .trim();

test("a message that fits is shown in full", () => {
  // No ellipsis, and nothing cut. The other half of the helper's boundary.
  expect(preview(row([message("hi")]))).toBe("hi");
});

test("a message of exactly the cap is not cut", () => {
  // `truncateString` compares `str.length <= num`, so 35 fits and 36 does not.
  // Testing only the over case would leave `<` and `<=` indistinguishable - the
  // off-by-one that turns a 35-character message into 35 characters plus three
  // dots that say it was longer than it was.
  const exact = "a".repeat(CAP);

  expect(exact.length).toBe(CAP);
  expect(preview(row([message(exact)]))).toBe(exact);
});

test("a message one character over the cap is cut, and says so", () => {
  const over = "b".repeat(CAP + 1);

  expect(preview(row([message(over)]))).toBe("b".repeat(CAP) + "...");
});

test("the preview is the room's newest message", () => {
  // The order itself is pinned by `room_message_order.spec.js`; what is pinned
  // here is that the row reads the *last* of them. `[0]` instead renders the
  // oldest message of the room as its preview, forever, and looks entirely
  // plausible while doing it.
  const older = message("the older one", 1);
  const newer = message("the newer one", 2);

  expect(preview(row([older, newer]))).toBe("the newer one");
});

test("a peer who is typing takes the preview's slot", async () => {
  // `:32` is the `v-if` and `:38` the `v-else`, so this is precedence rather
  // than both-at-once: while someone types you see them, not the message you
  // were reading. `whosWriting` is plain `data()`, so it is set directly here -
  // the EventBus path into it is `user_writing_listener.spec.js`'s subject, and
  // reaching it through the bus to test the *rendering* would be testing the bus
  // a second time.
  const wrapper = row([message("the message you were reading")]);

  expect(preview(wrapper)).toBe("the message you were reading");

  wrapper.setData({ whosWriting: "carol" });
  await wrapper.vm.$nextTick();

  expect(preview(wrapper)).toBe("carol is writing...");
  expect(preview(wrapper)).not.toContain("the message you were reading");

  // And back again - a peer who stops typing must not leave their name sitting
  // in the row's slot, which is what a `v-if` with no `v-else` would do.
  wrapper.setData({ whosWriting: "" });
  await wrapper.vm.$nextTick();

  expect(preview(wrapper)).toBe("the message you were reading");
});
