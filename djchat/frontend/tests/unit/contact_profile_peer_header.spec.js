/* eslint-env jest */
/**
 * The client's one read of a field the server sends.
 *
 * `ContactProfile.vue` reads `group_profile` in exactly one place - line 257,
 * `this.getRoom.group_profile || {}` - and five computeds hang off it. Four of
 * them are rendered: the avatar letter (`getAvatarName`), the name
 * (`getUsername`), the description (`getUserTagline`) and the avatar's
 * background colour (`getColor`, hashed off the same username).
 *
 * Before this file, nothing in the client pinned that field *name*. Measured,
 * not assumed: rename the one line to read `group_peek` instead and the whole
 * suite is **27 suites, 149 tests, green**. The profile header goes blank for
 * every chat in the app and no test notices, because
 *
 *   - the `|| {}` turns a missing field into an empty header rather than a
 *     crash, which is what makes it silent - a `TypeError` would have been the
 *     good outcome here;
 *   - the three specs carrying `group_profile` in their fixtures
 *     (`contact_profile_delete.spec.js:26`, `contact_profile_stale_error.spec.js:51`
 *     and `:147`, `room_export_links.spec.js:29-30`) mount this component, so
 *     line 257 *does* run under them - but none of them asserts anything it
 *     produced. They were covering the delete and the stale-message paths and
 *     happening to execute this line on the way past.
 *
 * This closes the client half of that seam. The producer half is already closed
 * and was closed by item 61: renaming the serializer's field alone turns
 * `test_group_name_reports_the_other_participant_for_private` red. Neither half
 * catches the other, which is the whole point - a consumer-only rename is what
 * left the client reading a field the server never sends.
 *
 * It does not close the *coordinated* rename, and this file is honest about
 * that rather than pretending otherwise: rename the server, the client and the
 * fixtures together and everything here stays green, because the fixtures are
 * written by hand. PLAN.md says the fix for that is "a single source of truth
 * for the contract, which is not a test", and that is right - it is a refactor
 * of these endpoints plus a shared fixture both halves read, not another
 * assertion here. What this file changes is the plan's other claim, that the
 * consumer half is "otherwise still open" and cannot be closed by a test. It
 * can: asserting that the header renders *from the field* is exactly what a
 * consumer-only rename breaks.
 *
 * The assertions are on rendered text, not on the computeds, for the reason
 * `contact_profile_delete.spec.js` gave: an error set in a field while the panel
 * showed nothing is not reported, so "on screen" has to be the claim.
 */
import { shallowMount } from "@vue/test-utils";
import ContactProfile from "@/components/profiles/ContactProfile.vue";

// Shaped like what `RoomSerializer.get_group_profile` returns for a private
// room (`serializers.py:70-81`): the *other* participant, serialized whole by
// `users.api.serializers.UserSerializer`, whose `Meta.fields` is
// `('id', 'username', 'email', 'tagline')`. All four are here because a fixture
// missing `id` is a state the store cannot reach - `item 61` had exactly that
// argument made for it, about a room the user could not have clicked.
//
// The peer name and the tagline are distinct strings precisely so that a
// component reading one and rendering the other cannot pass.
const ROOM = {
  id: 7,
  group_profile: {
    id: 2,
    username: "Bob",
    email: "bob@example.com",
    tagline: "about Bob"
  }
};

const mountProfile = () =>
  shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: {
        state: {
          width: 1200,
          selectedRoom: 7,
          rooms: { 7: ROOM },
          roomActivity: null
        },
        dispatch: jest.fn(() => Promise.resolve()),
        commit: jest.fn()
      }
    }
  });

test("the profile header is built from the field the server sends", () => {
  const wrapper = mountProfile();

  // Three of the four rendered outputs. `getColor` is deliberately absent: it
  // is the fourth consumer of the same read, so all three of these already go
  // blank with it, and a fourth assertion would pin one seam twice.
  expect(wrapper.find(".avatar-main-circle").text()).toBe("B");
  expect(wrapper.find("p.text-lg").text()).toBe("Bob");
  expect(wrapper.find("p.cursor-default").text()).toBe("about Bob");
});

test("a group room's name arrives through the same field", () => {
  // The serializer's other branch (`serializers.py:81`) sends a bare name
  // string wrapped in the same dict, with `id` null - a group has no single
  // profile to serialize. It is the same field name, so the header must build
  // the same way; a client that started reading `group_profile.id`, or falling
  // back to `room.group_name` here, would render a group's header blank while
  // leaving every private-room test green.
  const wrapper = shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: {
        state: {
          width: 1200,
          selectedRoom: 7,
          rooms: {
            7: {
              id: 7,
              group_profile: { id: null, username: "Study group", tagline: "" }
            }
          },
          roomActivity: null
        },
        dispatch: jest.fn(() => Promise.resolve()),
        commit: jest.fn()
      }
    }
  });

  expect(wrapper.find(".avatar-main-circle").text()).toBe("S");
  expect(wrapper.find("p.text-lg").text()).toBe("Study group");
});
