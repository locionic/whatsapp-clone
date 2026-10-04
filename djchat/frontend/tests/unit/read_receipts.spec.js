/* eslint-env jest */
/**
 * The read receipts, which were the last user-visible feature with no tests at all.
 *
 * `MessageSerializer` (`serializers.py:17-34`) sends three `SerializerMethodField`s:
 * `is_owner`, `all_received` and `all_read`. `is_owner` is covered - item 9 and
 * the message-order specs lean on it. The other two were read in three production
 * files and asserted by **nothing**:
 *
 *     grep -rl "\ball_received\b" tests/unit/   ->  nothing
 *
 * and `SentMessage.vue` was not mounted by any spec in the suite. Measured, not
 * assumed - renaming the field in either component, for either field, leaves the
 * whole suite green, four runs over:
 *
 *     SentMessage  message.all_received  -> message.all_recd     151 passed
 *     User         lastMessage.all_received -> lastMessage.all_recd  151 passed
 *     SentMessage  message.all_read      -> message.all_rd       151 passed
 *     User         lastMessage.all_read  -> lastMessage.all_rd    151 passed
 *
 * The visible effect of any of those is the same: the double tick never appears,
 * so every message in every chat reads as delivered-and-never-confirmed, and no
 * test notices. This is item 65's gap in its purest form - a server-sent field
 * the client depends on, with no assertion anywhere on this side.
 *
 * **The logic is written down twice**, and that is the reason this file has two
 * cases per behaviour rather than one. `SentMessage.vue:14-45` and
 * `User.vue:40-75` are near-verbatim copies - the same three icons, the same
 * three conditions, differing only in `message` vs `lastMessage` and a margin
 * class. A spec covering one would leave the other free to drift, which is a
 * refactor's problem and not this file's, but it *is* this file's problem for
 * the rename: each site has to be pinned or a rename of one alone passes.
 *
 * The four states, as the markup draws them. `v-if="message.sending"` gives the
 * clock; the double tick needs `allReceived[id] || message.all_received`; the
 * single tick is what is left, and it is gated on `!message.sending` so a message
 * in flight shows a clock and *no* tick rather than both.
 *
 * The store lookup is not decoration - it is the live path. The message arrives
 * from a fetch carrying whatever was true then; `MARK_MESSAGE_ALL_RECEIVED` /
 * `MARK_MESSAGE_ALL_READ` (`mutations.js:137-141`, both `Vue.set`, so reactive)
 * write the override keyed by message id when the push lands, and the render
 * prefers the store to the field. That precedence is the feature: without it a
 * receipt could only ever change when the next fetch landed.
 */
import { mount } from "@vue/test-utils";
import SentMessage from "@/components/messages/SentMessage.vue";
import User from "@/components/users/User.vue";

// What `MessageSerializer` emits for a sent message. `all_received` and
// `all_read` are the two under test; the rest is what the markup reads.
const MESSAGE = {
  id: 7,
  body: "hi",
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  sending: false,
  all_received: false,
  all_read: false
};

const inChat = (fields, state = {}) =>
  mount(SentMessage, {
    propsData: { message: { ...MESSAGE, ...fields } },
    mocks: {
      $store: {
        state: { allReceived: {}, allRead: {}, unreadMessages: {}, ...state },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });

// Everything `User.vue` reads off the room, and no less: `grep -o "room\.[a-z_]*"`
// is exactly these three, and all three are rendered unguarded. `group_name` is
// dereferenced twice (`room.group_name.charAt(0)` at :20 and `getHash` at :141)
// and `last_activity` goes through `dateFormat` at :162, so a room missing any of
// them throws inside the render and takes the whole room list with it - the
// render-error gate caught both on the first run of this file.
//
// Omitting them would be a fixture describing a state the store cannot reach,
// which is item 61's argument applied to a different component. `roomViews.py:325`
// refuses a nameless group, and a private room's `group_name` is the peer's
// username (`get_group_name`), so the server always sends all three.
const ROOM = {
  id: 7,
  group_name: "Bob",
  last_activity: "2026-01-01T10:00:00Z"
};

const inRoomList = (fields, state = {}) =>
  mount(User, {
    propsData: { room: ROOM },
    mocks: {
      $store: {
        state: {
          users: {},
          allReceived: {},
          allRead: {},
          roomMessages: { 7: [{ ...MESSAGE, ...fields }] },
          unreadMessages: {},
          ...state
        },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });

// Both components render exactly three `<i class="material-icons">` - the clock,
// the double tick and the single tick - so this is the receipt row and not a
// wider selector. Counted, not assumed: `grep -c material-icons` is 3 in each.
// **Tag-qualified since item 97**, which put a fourth `material-icons` in the
// sent bubble: the delete control borrows the same icon font, and it is a
// `button`, so this still selects the three receipts and nothing else. Narrowing
// rather than loosening - a receipt changed to a `<span>` now fails this where it
// would have passed on the bare class.
const icons = wrapper =>
  wrapper.findAll("i.material-icons").wrappers.map(one => one.text());

const SITES = [
  ["the sent message in a chat", inChat],
  ["the room list row", inRoomList]
];

test.each(SITES)(
  "%s: a message still in flight shows a clock and no ticks",
  (_name, mountAt) => {
    // Both at once would be the bug: the single tick is gated on
    // `!message.sending`, so a message that is on the wire shows neither a
    // clock and a tick, nor a tick it has not earned.
    expect(icons(mountAt({ sending: true }))).toEqual(["access_time"]);
  }
);

test.each(SITES)("%s: a delivered message shows one tick", (_name, mountAt) => {
  expect(icons(mountAt({}))).toEqual(["done"]);
});

test.each(SITES)(
  "%s: once everyone has received it, the tick doubles",
  (_name, mountAt) => {
    expect(icons(mountAt({ all_received: true }))).toEqual(["done_all"]);
  }
);

test.each(SITES)("%s: only a read message goes teal", (_name, mountAt) => {
  // Two assertions, because the class is on the double tick and a `done_all`
  // that never goes teal is a different bug from one that is always teal.
  const received = mountAt({ all_received: true });
  expect(received.find("i.material-icons").classes()).not.toContain(
    "text-teal-400"
  );

  const read = mountAt({ all_received: true, all_read: true });
  expect(read.find("i.material-icons").classes()).toContain("text-teal-400");
});

test.each(SITES)(
  "%s: a push overrides what the message said",
  (_name, mountAt) => {
    // The fetched message has not caught up...
    expect(icons(mountAt({ all_received: false }))).toEqual(["done"]);

    // ...and the override the push wrote wins over the field. Keyed by message
    // id, because that is what `App.vue:66-70` commits and what both mutations
    // write.
    expect(
      icons(mountAt({ all_received: false }, { allReceived: { 7: true } }))
    ).toEqual(["done_all"]);

    const read = mountAt(
      { all_received: false },
      { allReceived: { 7: true }, allRead: { 7: true } }
    );
    expect(read.find("i.material-icons").classes()).toContain("text-teal-400");
  }
);

test.each(SITES)(
  "%s: being read cannot outrun being received",
  (_name, mountAt) => {
    // The teal class rides on the double tick, so a message the store says was
    // read but not received still gets the plain single tick. Both halves of
    // this are the server's: `all_read` implies every pending_read is gone,
    // which implies every pending_reception is too.
    expect(
      icons(mountAt({ all_received: false }, { allRead: { 7: true } }))
    ).toEqual(["done"]);
  }
);
