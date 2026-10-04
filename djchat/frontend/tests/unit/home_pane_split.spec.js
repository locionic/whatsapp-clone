/* eslint-env jest */
/**
 * The gate that decides whether a chat is on screen at all.
 *
 * `Home.vue` splits into two layouts off one number, `state.width`, in the
 * opposite directions:
 *
 *     <SideRooms v-if="width < 768"    ... />   the mobile drawer
 *     <div v-if="width >= 768"><rooms /></div>  the desktop pane
 *
 * The two are a partition - `<` and `>=` cover every width exactly once - and
 * that is the only thing holding them together. Flip either operator and the
 * partition stops being one at the single width where the two comparisons
 * agree, which is the width that matters most:
 *
 *     width >= 768   -->   width > 768
 *
 * At 768 `768 > 768` is false, so the desktop pane stops rendering, and
 * `768 < 768` was already false, so the drawer is not there either. Nothing
 * renders. Worse, it is not a blank page: `openMobileRooms` (line 48) guards
 * itself with `if ("mobile-rooms" in this.$refs && ...)`, so tapping a
 * conversation in the list silently does nothing and the user is looking at a
 * room list that opens nothing, with no error anywhere to explain it.
 *
 * 768 is not an arbitrary pick, which is what makes this worth a pin. The
 * sibling column one line up is `<div class="w-full md:w-1/3">`, and `md` is
 * `768px` in `tailwind.config.js` - and in Tailwind 1.1.4's own defaults
 * (`node_modules/tailwindcss/stubs/defaultConfig.stub.js`), so it is 768 from
 * both directions. At exactly 768 CSS has already given the left column a
 * third of the screen. If the right-hand pane is absent there, a third of the
 * viewport is dead space on the most common tablet width, and the layout is
 * split by a number that only agrees with itself by accident.
 *
 * Item 61's crash sat behind this gate - `MessagesSection.vue` reached through
 * `rooms[selectedRoom]` with `selectedRoom` still `null` - and `Rooms.vue:13`
 * mounts it unconditionally, so the desktop branch is where that pane lives.
 * Item 63 pinned the switch that writes `state.width`; this pins where it is
 * read.
 *
 * `shallowMount`, not `mount`, because the assertion is *which* child is in the
 * tree and nothing below it: every child is stubbed, so no child's `created()`
 * hook runs and no child touches the store. What is left is `Home`'s own
 * render function - which is the whole subject.
 */
import { mount, shallowMount } from "@vue/test-utils";
import App from "@/App.vue";
import Home from "@/views/Home.vue";
import Rooms from "@/components/rooms/Rooms.vue";
import SideRooms from "@/components/rooms/SideRooms.vue";

let realWebSocket;

// `App.created()` calls `initializeWebSocketSupport()`, which constructs a real
// `WebSocket` against the test host. Replaced, not merely tolerated: App's
// `onclose` reschedules itself through `setTimeout`, so a socket that fails to
// connect leaves a retry timer running past the end of the test.
beforeAll(() => {
  realWebSocket = global.WebSocket;
  global.WebSocket = class {
    constructor() {
      /* never connects, so no handler fires and no retry is ever scheduled */
    }
  };
});

afterAll(() => {
  global.WebSocket = realWebSocket;
});

const mountAt = width => {
  const wrapper = shallowMount(Home, {
    mocks: {
      $store: {
        state: { width, selectedRoom: null },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });
  // Which of the two layouts is on screen. One boolean each, so a test can
  // say "the pane is there" without also pinning which element carries it.
  return {
    pane: () => wrapper.findComponent(Rooms).exists(),
    drawer: () => wrapper.findComponent(SideRooms).exists()
  };
};

test("a wide window gets the chat pane, not the mobile drawer", () => {
  const { pane, drawer } = mountAt(1200);

  expect(pane()).toBe(true);
  expect(drawer()).toBe(false);
});

test("a narrow window gets the drawer, not the chat pane", () => {
  // The other half. Without it, deleting the drawer outright - `v-if="false"`,
  // or the component unregistered - would pass every other test here and cost
  // phones their only route into a conversation.
  const { pane, drawer } = mountAt(600);

  expect(drawer()).toBe(true);
  expect(pane()).toBe(false);
});

test("at exactly 768 the chat pane is on screen", () => {
  // The boundary itself, because the boundary is the only width the two
  // branches can both claim or both lose. 767 and 769 are already covered by
  // the two tests above; this is the one they cannot reach.
  const { pane } = mountAt(768);

  expect(pane()).toBe(true);
});

test("every width gets exactly one layout", () => {
  // The invariant behind the three above, stated once: `<` and `>=` partition.
  // Proved over both sides of 768 and at it, rather than trusting two
  // comparisons to have been typed to agree.
  for (const width of [320, 600, 767, 768, 769, 1024, 1920]) {
    const { pane, drawer } = mountAt(width);

    expect([width, pane(), drawer()]).toEqual([
      width,
      width >= 768,
      width < 768
    ]);
  }
});

test("resizing moves the pane, rather than fixing it at first paint", async () => {
  // `WindowSize` commits on `created` and again on every `resize`
  // (window_size.spec.js), so the width changes long after the first render.
  // A `v-if` that read a value once - a snapshot in `data`, or the branch
  // chosen at mount and never revisited - would render the right layout once
  // and then be wrong for the rest of the session.
  const wrapper = shallowMount(Home, {
    mocks: {
      $store: {
        state: { width: 1200, selectedRoom: null },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });

  expect(wrapper.findComponent(Rooms).exists()).toBe(true);

  // Down past the boundary, then back up to it: both directions, for the same
  // reason window_size.spec.js tests both.
  wrapper.vm.$store.state.width = 600;
  await wrapper.vm.$nextTick();
  expect(wrapper.findComponent(Rooms).exists()).toBe(false);
  expect(wrapper.findComponent(SideRooms).exists()).toBe(true);

  wrapper.vm.$store.state.width = 768;
  await wrapper.vm.$nextTick();
  expect(wrapper.findComponent(Rooms).exists()).toBe(true);
  expect(wrapper.findComponent(SideRooms).exists()).toBe(false);
});

test("the pane's number exists before the pane's first render", () => {
  // The input side of the same gate. `state.width` starts as `null`
  // (`state.js:32`) and `null >= 768` is false, so a first render that ran
  // before `WindowSize` measured anything would render the *phone* layout on a
  // desktop - drawer yes, pane no - and keep it for as long as the wrong value
  // lasted. It is right today because `<window-size />` is line 3 of `App.vue`
  // and `<router-view />` is line 5, so the producer's `created()` commits
  // before the consumer's first render. Nothing else pins that order: every
  // test above supplies its own width, so move one line down and all five
  // still pass.
  //
  // So this mounts the real `App` and stands in for `router-view`, recording
  // `state.width` at the moment the page underneath would first render.
  const seen = [];
  const state = { width: null, selectedRoom: null };

  mount(App, {
    mocks: {
      $store: {
        state,
        // What the real store does with it, reactively. This is the only
        // commit that happens before the assertion below.
        commit: (name, value) => {
          if (name === "SET_CURRENT_WIDTH") state.width = value;
        },
        dispatch: jest.fn()
      }
    },
    stubs: {
      "router-view": {
        name: "RouterViewStub",
        render(h) {
          seen.push(this.$store.state.width);
          return h("div");
        }
      }
    }
  });

  // Not `not.toBeNull()`: the exact measurement is the stronger claim, and it
  // is the one that stays true if `WindowSize` ever stops reporting the real
  // window and starts reporting a default.
  expect(seen[0]).toBe(window.innerWidth);
});
