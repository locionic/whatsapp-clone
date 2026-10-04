/* eslint-env jest */
/**
 * The invitation row's two controls used to be `<i>` elements with a `@click`.
 *
 * That is a real control to a mouse and nothing else. An `<i>` is not focusable,
 * carries no role, and its only text is the Material Icons ligature - so a
 * keyboard user cannot reach "Accept" or "Reject" at all, and a screen reader
 * is offered "person_add" or "delete" rather than what the button does. The
 * whole surface is three lines per control and every one of them is the
 * accessibility-critical part: these are the accept and reject buttons for a
 * friendship request.
 *
 * `tabIndex` is the assertion that does the work. A native `<button>` is 0;
 * the `<i>` and `<div>` that were here instead are -1. So this fails on the
 * regression, not just on the tag.
 */
import { mount } from "@vue/test-utils";
import UserInvitation from "@/components/invitations/UserInvitation.vue";

function mountRow(received = true) {
  return mount(UserInvitation, {
    propsData: {
      invitation: { id: 7 },
      user: { username: "alice", email: "alice@example.com" },
      received
    }
  });
}

// Each control needs a name that says what it does. Asserted as a non-empty
// match rather than an exact string so a reword is not a failure, but a
// dropped `aria-label` is.
const NAMED = /accept|reject|cancel/i;

describe("the invitation row's controls", () => {
  it("are focusable controls, not icons with a click handler", () => {
    const buttons = mountRow().findAll("button");

    expect(buttons.length).toBe(2);
    buttons.wrappers.forEach(button => {
      // -1 would mean it is back to being unreachable by Tab.
      expect(button.element.tabIndex).toBe(0);
      // type="button" keeps a row of these from submitting a surrounding form.
      expect(button.attributes("type")).toBe("button");
      expect(button.attributes("aria-label")).toMatch(NAMED);
    });
  });

  it("keeps the icon ligature out of the accessible name", () => {
    // The glyph is text content, so without this a screen reader reads
    // "person_add" -- the font's internal name, not the action.
    const buttons = mountRow().findAll("button");
    // Not decoration. Forgetting this line made the whole test pass on the
    // broken component: zero buttons, a forEach over nothing, no failure.
    expect(buttons.length).toBeGreaterThan(0);
    buttons.wrappers.forEach(button => {
      expect(button.find("i").attributes("aria-hidden")).toBe("true");
    });
  });

  it("still accepts on click", async () => {
    const wrapper = mountRow();

    await wrapper.findAll("button").at(0).trigger("click");

    expect(wrapper.emitted("add")).toEqual([[7]]);
  });

  it("still removes on click", async () => {
    const wrapper = mountRow();

    await wrapper.findAll("button").at(1).trigger("click");

    expect(wrapper.emitted("remove")).toEqual([[7]]);
  });

  it("offers only remove on a sent invitation", () => {
    // `received` gates the accept control in the template; if that gating is
    // lost the count below is the thing that notices.
    const buttons = mountRow(false).findAll("button");

    expect(buttons.length).toBe(1);
    expect(buttons.at(0).attributes("aria-label")).toMatch(/cancel/i);
  });
});