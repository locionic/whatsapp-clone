/* eslint-env jest */
/**
 * Press Accept, Reject or Cancel, and watch nothing happen.
 *
 * `Invitations.vue` is the only screen where a friend request can be acted on.
 * Its three handlers are bare dispatches:
 *
 *   acceptInvitation(invitationId) {
 *     this.$store.dispatch("acceptFriendRequest", invitationId);
 *   }
 *
 * Each store action commits the refreshed list on the resolve path and calls
 * `reject(error)` on the failure path, so a refusal propagates out of the
 * component as an unhandled promise rejection. `data()` holds one field,
 * `selectedTab`; there is no `error` and no element in the template that could
 * show one.
 *
 * So the row stays exactly where it was, the badge stays where it was, and no
 * message appears anywhere. Nothing distinguishes "the server refused" from
 * "the click did not register" -- and the user is left with an invitation whose
 * only remaining action is to press again.
 *
 * Item 18 fixed the same class of defect in `InvitationModal.vue`, where the
 * catch existed but dereferenced `error.response` unguarded and therefore
 * threw a TypeError instead of assigning the message. Here there is no catch at
 * all, so that fix does not reach it.
 *
 * The Django half of the same failure -- the push that would have stopped the
 * row from going stale in the first place -- is
 * `test_the_accepter_is_told_to_refresh_their_sent_list` in
 * `friends/_tests/test_friendship_api.py`.
 */
import fs from "fs";
import path from "path";
import { mount } from "@vue/test-utils";
import Invitations from "@/components/invitations/Invitations.vue";

function mountWith(dispatch) {
  return mount(Invitations, {
    // The tabs render whatever the store hands them, and the child components
    // bring their own store reads and vue-feather imports. Neither is under
    // test; stubbing them keeps the render to the error surface itself.
    stubs: { "user-invitation": true, "invite-friend": true },
    mocks: {
      $store: {
        state: { sentInvitations: {}, receivedInvitations: {} },
        commit: jest.fn(),
        dispatch
      }
    }
  });
}

const refuse = () => jest.fn(() => Promise.reject(new Error("404")));

const ACTIONS = [
  ["acceptInvitation", "acceptFriendRequest"],
  ["rejectInvitation", "rejectFriendRequest"],
  ["cancelInvitation", "cancelFriendRequest"]
];

// Item 19's wording for the same failure on the delete-chat button
// (`ContactProfile.vue:188`), reused rather than a third tone. The regex is
// loose enough to survive a wording change and the success assertions below
// are what pin that it is not showing when it should not.
const REFUSAL = /could not be updated/i;

// `error` is set inside the catch, so the DOM is one tick behind the promise.
// Reading `wrapper.text()` straight after the `await` sees the pre-render
// tree -- which reads as "the fix did not work" for a fix that worked.
const settle = wrapper => wrapper.vm.$nextTick();

// What the template actually wires to a row. ACTIONS is the contract the two
// test.each blocks below check against, but nothing was checking it against the
// component: add a fourth action to Invitations.vue and every one of those tests
// stays green while the new action is covered by nothing, and a typo in its
// dispatch name surfaces only as an invitation that never updates. Reading the
// template makes that a failure here instead of silence.
const VUE_FILE = path.resolve(
  __dirname,
  "../../src/components/invitations/Invitations.vue"
);

function wiredHandlers() {
  const source = fs.readFileSync(VUE_FILE, "utf8");
  const template = source.slice(
    source.indexOf("<template>"),
    source.indexOf("</template>")
  );
  const names = new Set();
  // Scoped to the row component, and to any event on it rather than the two it
  // happens to use today. A fourth action would arrive with a new event name of
  // its own -- that is the whole shape of the gap -- so a scan limited to
  // `@add`/`@remove` passes straight over it. The leading `@` keeps `:prop`
  // bindings out, and requiring a bare identifier drops expression handlers.
  const rows = template.match(/<user-invitation\b[\s\S]*?\/>/g) || [];
  for (const row of rows) {
    const binding = /@[\w-]+="([A-Za-z_$][\w$]*)"/g;
    let match;
    while ((match = binding.exec(row)) !== null) names.add(match[1]);
  }
  return [...names].sort();
}

test("every handler the template wires to a row is in the table", () => {
  expect(wiredHandlers()).toEqual(ACTIONS.map(([method]) => method).sort());
});

// The store actions reject on failure; the handler's job is to notice. Assert
// the method resolves as well as rendering the text, because a fix that
// re-threw instead of catching would leave the rejection unhandled either way,
// and `resolves` fails on that alone -- a clearer report than a text mismatch.
test.each(ACTIONS)("%s reports a refusal", async method => {
  const wrapper = mountWith(refuse());

  await expect(wrapper.vm[method](42)).resolves.toBeUndefined();
  await settle(wrapper);

  expect(wrapper.text()).toMatch(REFUSAL);
});

test.each(ACTIONS)("%s says nothing on success", async (method, action) => {
  // The control: an error that appeared unconditionally would pass the three
  // above while being wrong every time the action works.
  const dispatch = jest.fn(() => Promise.resolve({ data: [] }));
  const wrapper = mountWith(dispatch);

  await wrapper.vm[method](42);
  await settle(wrapper);

  expect(dispatch).toHaveBeenCalledWith(action, 42);
  expect(wrapper.text()).not.toMatch(REFUSAL);
});

test("a later success clears an earlier failure", async () => {
  // Without the clear, one failed cancel leaves the message up for the rest of
  // the session -- on the Sent tab, over invitations that are fine.
  let refuseNext = true;
  const dispatch = jest.fn(() =>
    refuseNext ? Promise.reject(new Error("404")) : Promise.resolve({})
  );
  const wrapper = mountWith(dispatch);

  await wrapper.vm.cancelInvitation(1);
  await settle(wrapper);
  expect(wrapper.text()).toMatch(REFUSAL);

  refuseNext = false;
  await wrapper.vm.cancelInvitation(2);
  await settle(wrapper);

  expect(wrapper.text()).not.toMatch(REFUSAL);
});
