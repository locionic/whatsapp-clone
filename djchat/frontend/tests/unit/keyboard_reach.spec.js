/* eslint-env jest */
/**
 * Item 38 fixed the invitation row and named what it left: "the room list is the
 * single most-used interactive surface here and every row is a `<div>`". This is
 * that, plus the two smaller surfaces in the same class.
 *
 * `UsersSection.vue` opens every room in the app. Its row is
 *
 *     <div v-for="room in rooms" :key="room.id" @click="selectRoom(room.id)">
 *
 * A mouse can select a chat. A keyboard cannot reach it at all: the div has no
 * `tabindex`, so it is not in the tab order, and no handler for Enter or Space.
 * There is no `<form>` to submit and no sibling button to arrow onto, so the list
 * is simply outside the keyboard's reach. The header avatar (the same file, one
 * `<div @click>`) and MessagesSection's "(go to bottom)" are the same defect.
 *
 * `tabIndex` is the assertion that does the work. A focusable element is 0; the
 * div and the `<p>` that were here instead are -1. So this fails on the real
 * regression, not just on the tag name.
 */
import { mount } from "@vue/test-utils";
import UsersSection from "@/components/users/UsersSection.vue";
import MessagesSection from "@/components/messages/MessagesSection.vue";

const ROOM = { id: 7, group_name: "Bob", last_activity: "2026-01-01T10:00:00Z" };

function mountList() {
  return mount(UsersSection, {
    // `search`, `menu` and `invite-friend` bring their own store reads and
    // imports; `user` is deliberately NOT stubbed, because the row's accessible
    // name comes from the name and preview it renders.
    // `Menu` is the registration key (PascalCase), not `menu`. vue-test-utils 1
    // matches stub keys against it, and a lowercase `menu` silently matches
    // nothing - proven two dozen lines down, where `stubs: { menu: true }` left
    // the real Menu rendered and `find("button")` resolved to it.
    stubs: { search: true, Menu: true, "invite-friend": true },
    mocks: {
      $store: {
        state: {
          rooms: { 7: ROOM },
          selectedRoom: null,
          // Menu is stubbed but its v-if still evaluates.
          width: 1200,
          userProfile: { username: "alice" },
          allReceived: {},
          allRead: {},
          roomMessages: {},
          unreadMessages: {},
          users: {}
        },
        commit: jest.fn(),
        dispatch: jest.fn()
      }
    }
  });
}

function mountSection() {
  return mount(MessagesSection, {
    // `menu` for the same reason `mountList` above stubs it, and it used to
    // matter here in a way that is worth recording. `Menu.vue` was hover-only
    // markup around an <i>, so it contained no button at all and this file could
    // say "nothing else in MessagesSection is a button, so this is
    // unambiguous" and be right. Item 50 gave the menu a real <button> trigger,
    // which is the fix, and that sentence became false -- `find("button")` kept
    // resolving to the *menu*, 200 lines above this one in the template, and
    // two tests here started asserting against the wrong element without any
    // error. Stubbing makes the assumption true by construction instead of by a
    // coincidence of what the subtree happens to contain today.
    stubs: { Menu: true },
    mocks: {
      $store: {
        state: {
          selectedRoom: 7,
          roomMessages: {
            7: [{ id: 1, room: 7, body: "hi", author: 1, timestamp: "2026-01-01" }]
          },
          unreadMessages: {},
          rooms: { 7: { id: 7, group_name: "Bob" } },
          users: { 1: { id: 1, username: "Bob" } },
          allReceived: {},
          allRead: {}
        },
        commit: jest.fn(),
        dispatch: jest.fn(() => Promise.resolve({ data: { messages: [] } }))
      }
    }
  });
}

beforeAll(() => {
  // jsdom has no layout, so Element.scrollTo is absent; `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

const settle = wrapper => wrapper.vm.$nextTick();

describe("a room row", () => {
  it("is reachable by Tab", () => {
    const row = mountList().find('[role="button"]');

    // -1 would mean it is still outside the tab order.
    expect(row.element.tabIndex).toBe(0);
  });

  it("says which chat it opens, without an aria-label", () => {
    // Name from content, which is why `user` is not stubbed above. An
    // aria-label here would be worse than nothing: it would name the button
    // "Bob" and then hide the last message and timestamp inside it.
    const row = mountList().find('[role="button"]');

    expect(row.text()).toContain("Bob");
  });

  it("selects the room on Enter", async () => {
    const wrapper = mountList();

    await wrapper.find('[role="button"]').trigger("keydown.enter");

    expect(wrapper.vm.$store.commit).toHaveBeenCalledWith("SET_SELECTED_ROOM", 7);
    expect(wrapper.emitted("selected-room")).toBeTruthy();
  });

  it("selects the room on Space", async () => {
    // Space is the other half of the button contract. Without it the row is
    // reachable but not operable, which is the failure in a new position.
    const wrapper = mountList();

    await wrapper.find('[role="button"]').trigger("keydown.space");

    expect(wrapper.vm.$store.commit).toHaveBeenCalledWith("SET_SELECTED_ROOM", 7);
  });

  it("still selects on click", async () => {
    // The control: an Enter handler alone would pass the two tests above while
    // breaking the app for the mouse.
    const wrapper = mountList();

    await wrapper.find('[role="button"]').trigger("click");

    expect(wrapper.vm.$store.commit).toHaveBeenCalledWith("SET_SELECTED_ROOM", 7);
  });

  it("marks the open room for anyone who cannot see it is selected", async () => {
    // `isSelected` tints the row `bg-gray-200` inside `User.vue` and goes no
    // further, so tabbing through the list gives no way to tell which chat is
    // open. Vue drops the attribute when the binding is false, so the assertion
    // is presence, not a comparison against "false".
    const wrapper = mountList();
    const row = () => wrapper.find('[role="button"]');
    expect(row().attributes("aria-current")).toBeUndefined();

    wrapper.vm.$store.state.selectedRoom = 7;
    await settle(wrapper);

    expect(row().attributes("aria-current")).toBe("true");
  });
});

describe("the header avatar", () => {
  it("is a named control, not a div with a click handler", async () => {
    // Scoped to the search panel: `User.vue` also renders an `.avatar-circle`,
    // one per room row, and this component is not stubbed.
    const avatar = mountList().find(".search-panel .avatar-circle");

    expect(avatar.element.tagName).toBe("BUTTON");
    expect(avatar.attributes("type")).toBe("button");
    expect(avatar.element.tabIndex).toBe(0);
    // Its only text is one letter -- the user's initial -- which is a name no
    // screen reader user can act on.
    expect(avatar.attributes("aria-label")).toMatch(/profile/i);
  });

  it("still opens the profile", async () => {
    const wrapper = mountList();

    await wrapper.find(".search-panel .avatar-circle").trigger("click");

    expect(wrapper.emitted("profile")).toBeTruthy();
  });
});

describe("the go-to-bottom link", () => {
  it("is a control, not a p", async () => {
    const wrapper = mountSection();
    // Component state, set from a WebSocket push in the running app.
    wrapper.vm.newMessagesReceived = true;
    await settle(wrapper);

    // `.sticky button`, not `find("button")`. The comment above `mountSection`
    // records how this selector already went wrong once: item 50 gave the menu a
    // real trigger and these two tests quietly began asserting against it. Stubbing
    // Menu closed that one hole and nothing else -- item 76 added a search bar
    // above this banner, so `find("button")` was the *search* button and both
    // tests failed on the right defect for the wrong reason. The banner is a
    // `.sticky` div, and nothing else in this subtree is.
    const button = wrapper.find(".sticky button");
    expect(button.element.tabIndex).toBe(0);
    expect(button.attributes("type")).toBe("button");
    expect(button.text()).toContain("go to bottom");
  });

  it("still scrolls to the bottom", async () => {
    const wrapper = mountSection();
    wrapper.vm.newMessagesReceived = true;
    await settle(wrapper);
    // jsdom reports every scroll dimension as 0, so a bare `toHaveBeenCalled`
    // would pass on a handler that scrolled to the top of the list. The height
    // is the point of the button, so give it one.
    Object.defineProperty(wrapper.vm.$refs.messages, "scrollHeight", {
      value: 900,
      configurable: true
    });
    window.Element.prototype.scrollTo.mockClear();

    await wrapper.find(".sticky button").trigger("click");

    // Not the banner. `scrollToBottom` only scrolls -- `newMessagesReceived` is
    // cleared by `onScroll` when the list reaches its end, and jsdom fires no
    // scroll event, so that second half is not observable here.
    expect(window.Element.prototype.scrollTo).toHaveBeenCalledWith(0, 900);
  });
});