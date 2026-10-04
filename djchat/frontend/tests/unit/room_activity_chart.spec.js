/* eslint-env jest */
/**
 * The activity chart in the contact profile.
 *
 * A chart that is quietly wrong still looks like a chart: a bar for the wrong
 * day, or the previous room's bars under the new room's name, both render
 * fine. These assert the geometry and the room match, not that "some" bars
 * appear.
 */
import { shallowMount } from "@vue/test-utils";
import ContactProfile from "@/components/profiles/ContactProfile.vue";

const BAR_HEIGHT = 40;

function activityFor(counts, roomId = 7) {
  return {
    room_id: roomId,
    days: counts.length,
    total: counts.reduce((a, b) => a + b, 0),
    peak: Math.max(...counts),
    per_day: counts.map((count, i) => ({ date: `2026-01-${i + 1}`, count }))
  };
}

function mountWith(activity, selectedRoom = 7) {
  return shallowMount(ContactProfile, {
    propsData: { rightSidenav: false },
    mocks: {
      $store: {
        state: {
          roomActivity: activity,
          selectedRoom: selectedRoom,
          rooms: { 7: { id: 7 } }
        },
        dispatch: jest.fn(),
        commit: jest.fn()
      }
    }
  });
}

test("one bar per day, tallest day filling the whole height", () => {
  const wrapper = mountWith(activityFor([0, 2, 4]));
  const bars = wrapper.vm.getBars;

  expect(bars).toHaveLength(3);
  expect(bars[2].h).toBe(BAR_HEIGHT); // the peak
  expect(bars[1].h).toBe(BAR_HEIGHT / 2);
  expect(bars[0].h).toBe(0); // a quiet day still gets a bar
});

test("the chart is exactly as wide as the series", () => {
  // Otherwise changing ACTIVITY_DAYS on the backend shifts every bar.
  const wrapper = mountWith(activityFor([1, 3, 2, 0, 1]));

  // getAttribute, not attributes(): SVG attribute names are case-sensitive,
  // and the wrapper keys them lowercased.
  expect(wrapper.find("svg").element.getAttribute("viewBox")).toBe(
    `0 0 ${wrapper.vm.getBars.length} ${BAR_HEIGHT}`
  );
  expect(wrapper.findAll("rect")).toHaveLength(5);
});

test("the previous room's chart is not drawn under the new room", () => {
  // Switching rooms faster than the request returns leaves the old payload in
  // the store; matching only on "something is loaded" would show it.
  const wrapper = mountWith(activityFor([1, 2], 7), 99);

  expect(wrapper.vm.getActivity).toBeNull();
  expect(wrapper.vm.getBars).toEqual([]);
  expect(wrapper.find("svg").exists()).toBe(false);
});

test("a room with no messages gets the empty state, not a flat chart", () => {
  const wrapper = mountWith(activityFor([0, 0, 0]));

  expect(wrapper.vm.getActivity).toBeNull();
  expect(wrapper.find("svg").exists()).toBe(false);
});
