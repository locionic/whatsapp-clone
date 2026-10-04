/* eslint-env jest */
/**
 * The one thing a sidebar row is *for*: telling you which chat it opens.
 *
 * `User.vue` is the row, and it renders the room's name twice - once as the
 * avatar letter at line 20, once as the label at line 24 - both from
 * `room.group_name`, and nothing else on the row can identify the room. The
 * letter was asserted by nothing. Measured, not assumed:
 *
 *     User.vue:20  {{ room.group_name.charAt(0).toUpperCase() }}
 *              -> {{ String(room.id).charAt(0).toUpperCase() }}
 *
 * leaves the suite **29 suites, 166 tests, green**. The sidebar renders the
 * room's *id* where its initial belongs, in every chat, and no test notices.
 * Dropping `.toUpperCase()` is equally invisible, so the derivation itself -
 * not just the field - was unpinned.
 *
 * The name at :24 *is* covered, and the reason it is covered is the thing worth
 * recording. It is caught by exactly one assertion in the whole suite -
 * `keyboard_reach.spec.js:112`, `expect(row.text()).toContain("Bob")` - and that
 * assertion is not about the name. It is about an accessibility label, and it
 * pins the name only because it asks whether the row's entire text mentions the
 * room. Coverage that arrived sideways is coverage that leaves when the test
 * that carried it is rewritten; this makes it deliberate.
 *
 * Why `group_name` rather than `group_profile`: the row predates the profile
 * field, and this component never adopted it - `getColor` at :141 and both
 * template lines read `group_name` directly. So the row is the one place in the
 * client still on the *older* of the two fields the server sends for a room's
 * identity. Item 65 pinned `group_profile` for `ContactProfile`; this pins
 * `group_name` for the row, and neither half makes the other redundant.
 *
 * `getColor` is deliberately absent, for item 65's reason: it is a pure function
 * of the same single read as the name, so pinning the name pins the read and a
 * fourth assertion would pin one seam twice. A bug inside the hash would survive
 * here exactly as it survives there.
 *
 * The fixture carries all three fields `grep -o "room\.[a-z_]*" User.vue` turns
 * up - `group_name`, `id`, `last_activity` - because each is dereferenced
 * unguarded: `.charAt(0)` at :20 and `getHash` at :141 throw on a missing name,
 * and `dateFormat` at :153 throws on a missing `last_activity`. This is item 61's
 * trap, and the item-62 render gate caught both violations when this file was
 * first written.
 */
import { mount } from "@vue/test-utils";
import User from "@/components/users/User.vue";

const MESSAGE = {
  id: 7,
  body: "hi",
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  sending: false,
  all_received: false,
  all_read: false
};

// The room's identity, in the shape `RoomSerializer.get_group_name` sends it:
// the *peer's* username for a private room, the group's own name otherwise
// (`serializers.py:61-68`). `id` and `last_activity` are there for the reasons in
// the header, not because the row renders them as text.
const room = (id, group_name) => ({
  id,
  group_name,
  last_activity: "2026-01-01T10:00:00Z"
});

const row = (id, group_name) =>
  mount(User, {
    propsData: { room: room(id, group_name) },
    mocks: {
      $store: {
        state: {
          users: {},
          allReceived: {},
          allRead: {},
          // `lastMessage` (:159) indexes into this before it guards, so the key
          // must exist even when the room has no messages.
          roomMessages: { 7: [MESSAGE], 9: [MESSAGE], 11: [MESSAGE] },
          unreadMessages: {}
        },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });

// The letter. `User.vue` has exactly one `.avatar-circle` (:15); `keyboard_reach`
// has to scope its own query to `.search-panel .avatar-circle` because
// `ContactProfile` and `MessagesSection` have theirs too, but none of those are
// in this tree.
const letter = wrapper => wrapper.find(".avatar-circle").text();

// The label. `p.text-base` is :24 and nothing else in the row carries that class
// - the timestamp beside it is `text-xs`.
const label = wrapper => wrapper.find("p.text-base").text();

test("the row's initial is the first character of its name", () => {
  // Lowercase on purpose: `toUpperCase()` is half the logic and was unpinned,
  // so the fixture must be one where dropping it changes the answer.
  expect(letter(row(7, "bob"))).toBe("B");
});

test("the initial and the label come from the same name", () => {
  // The mutation this file exists for. Both values move together here, and both
  // change with the room - so a row reading `room.id` for its initial while
  // reading `group_name` for its label cannot pass, at any id.
  const bob = row(7, "Bob");
  expect(letter(bob)).toBe("B");
  expect(label(bob)).toBe("Bob");

  // A second room, same fixture, different name *and* different id, so the
  // assertion cannot be satisfied by either field alone.
  const carol = row(9, "Carol");
  expect(letter(carol)).toBe("C");
  expect(label(carol)).toBe("Carol");
});

test("an initial that is not a letter is shown as-is", () => {
  // `charAt(0)`, not "the first *alphabetic* character". That is a decision, and
  // it is the one thing a future "make the avatar nicer" change would silently
  // reverse: skipping to the first letter would turn "3 blind mice" into "b".
  expect(letter(row(7, "3 blind mice"))).toBe("3");
  expect(label(row(7, "3 blind mice"))).toBe("3 blind mice");
});

test("a group room's name is shown the same way a person's is", () => {
  // `group_name` carries both cases and the row cannot tell them apart - the
  // kind is on `room.kind` and the row never reads it. Worth saying out loud,
  // because the obvious "fix" for a name that looks like a username is to read
  // `group_profile` here instead, which would render a group room blank.
  const group = row(11, "Study group");
  expect(letter(group)).toBe("S");
  expect(label(group)).toBe("Study group");
});
