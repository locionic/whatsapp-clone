/* eslint-env jest */
/**
 * The invite button's emit chain, which nothing else in this suite renders.
 *
 * `window_size.spec.js:11` used to record these components as safe to leave
 * unmounted: "the rest of the unmounted components (`SuccessAlert`,
 * `InviteFriend`) are one prop and a slot with no logic between them." That was
 * true of `InviteFriend` and is no longer true of it, because
 * `InviteFriend.vue:6` is a re-emit:
 *
 *     <invite-button @action="$emit('invite-action')" class="mt-5" />
 *
 * So the sentence rested on a premise that the component has since outgrown,
 * and nothing noticed. Both files are reachable -- `Invitations.vue:113` and
 * `UsersSection.vue:81` both import `InviteFriend` -- and the re-emit was
 * rendered by nothing anywhere, because the one spec that mounts a live parent
 * stubs it out (`invitations_refusal.spec.js`, `stubs: { "invite-friend": true }`,
 * with a stated reason: the child brings its own store reads and vue-feather
 * imports). That is a correct decision for what that spec is about.
 *
 * **Why no coverage run could have said so, which is the part worth having.**
 * `InviteFriend.vue` is *not* missing from the report. It is in it, at 100%,
 * and it was before this spec existed -- because `Invitations.vue` imports it
 * at module level, so vue-jest transforms it whenever that spec runs. The
 * number is true and it means nothing: the file has **2 instrumented
 * statements and 0 functions**, which is its `export default` object and
 * nothing else. The template is not in the coverage model at all, because
 * vue-jest compiles it to a generated render function and
 * `babel-plugin-istanbul` does not see generated code. So the re-emit on line 6
 * is the one part of the file that was never measured, and the 100% is
 * computed from the two lines around it. `InviteButton.vue` is absent from the
 * report whether or not it is rendered, for the same reason taken one step
 * further: no `<script>` block, so zero instrumentable statements.
 *
 * **The gap is one line, and it is the whole button.** `InviteButton` emits
 * `action`; `InviteFriend` turns it into `invite-action`; the parents listen
 * for `invite-action` and only that. Break the re-emit -- a typo, a renamed
 * event, `@action` bound to nothing -- and the button still renders, still
 * looks right, and `Invitations.vue` and `UsersSection.vue` both keep reporting
 * 100%, because their templates are outside the model too. The user gets a
 * button that does nothing, and every number in the coverage table is green.
 */
import { mount } from "@vue/test-utils";
import InviteButton from "@/components/invitations/InviteButton.vue";
import InviteFriend from "@/components/invitations/InviteFriend.vue";

test("the button says what it offers, since it has no icon to carry the meaning", () => {
  const wrapper = mount(InviteButton);

  expect(wrapper.find("button").text()).toBe("Invite a Friend");
});

test("clicking the button is what starts the chain", () => {
  // `InviteButton`'s entire script is absent -- the emit lives in the template,
  // on the element itself -- so there is no `methods` entry to reach for. The
  // click is the only thing the component does, and this is the only place the
  // suite does it.
  const wrapper = mount(InviteButton);

  wrapper.find("button").trigger("click");

  expect(wrapper.emitted("action")).toHaveLength(1);
});

test("the wrapper turns it into the event its parents listen for", () => {
  // The line under test. The name is asserted rather than the count because
  // the count is the same whichever way it breaks: a re-emit that fires
  // nothing, and a re-emit that fires the wrong name, both look like a button
  // that was clicked. `invite-action` is the string on `Invitations.vue:74` and
  // `UsersSection.vue:65`, so getting it wrong here is what the parents
  // listen to least.
  const wrapper = mount(InviteFriend);

  wrapper.find("button").trigger("click");

  expect(wrapper.emitted("invite-action")).toHaveLength(1);
});

test("the child is not swallowed on the way through, or the parents lose the button", () => {
  // The one thing that would make the test above pass for the wrong reason. A
  // stubbed child still receives the parent's `invite-action` emit, so a spec
  // that mounted `InviteFriend` with `stubs: { "invite-button": true }` would
  // see the right event and no button at all. Asserting the child rendered is
  // what makes the re-emit a fact about the wiring.
  const wrapper = mount(InviteFriend);

  expect(wrapper.find("button").text()).toBe("Invite a Friend");
});

test("the wrapper still passes its slot through, which is where the copy differs", () => {
  // `Invitations.vue:78-80` and `99-103` use the slot for a message, the bare
  // `<invite-friend>` at `74` does not. The slot is the only thing that makes
  // those three call sites differ, so dropping it would be invisible until a
  // user saw an empty panel.
  const wrapper = mount(InviteFriend, {
    slots: { default: "<p>Say hello to a friend!</p>" }
  });

  expect(wrapper.text()).toContain("Say hello to a friend!");
});
