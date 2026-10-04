/* eslint-env jest */
/**
 * The "add a friend" modal keeps an error after the error is over.
 *
 * `Home.vue:11` mounts `<invitation-modal />` with no `v-if`, so this component
 * lives for the whole session. `error` and `friendEmail` are `data`, and:
 *
 *   - `this.error` is assigned in exactly two places, both `catch` blocks.
 *     Nothing ever assigns it back to "". So the first failure of the session
 *     paints a message that no later event can take down.
 *   - `friendEmail` is only ever written by the input's `v-model`, never
 *     cleared: `addFriend()` sets `showModal = false` on success and leaves the
 *     typed address sitting in the field.
 *   - `open()` and `close()` only flip `showModal`.
 *
 * The user-visible path, and it is an ordinary one:
 *
 *   1. Type `bob@gmial.com` (typo), press Send -> "User not found."
 *   2. Notice the typo, fix it to `bob@gmail.com`, press Send -> the invitation
 *      is sent and the modal closes. Good.
 *   3. Press Send again a minute later to invite someone else. The modal opens
 *      on the previous address, with "User not found." still under it -- an
 *      error about an address that is no longer in the box, for a lookup that
 *      has not been attempted yet.
 *
 * Step 3 is the defect: the message outlives the failure that produced it and
 * describes a state that is no longer true. It also blocks the common case,
 * because pressing Send on the stale address re-invites `bob@gmail.com` and
 * comes back "You have already sent an invitation."
 *
 * This is the same shape as items 8 and 18, one layer over. Those fixed a
 * failure that reported *nothing*; this is a failure that reported something
 * and then never stopped.
 */
import { shallowMount } from "@vue/test-utils";
import InvitationModal from "@/components/invitations/InvitationModal.vue";

const NOT_FOUND = "User not found.";

// The body the server sends with this 400. Built by hand rather than measured
// from the view -- jest cannot import the model -- but it is the same string
// `test_each_refusal_carries_its_own_reason` pins on the Django side.
const ALREADY_PENDING = "Friendship request already exists.";

const notFound = () =>
  Object.assign(new Error("failed"), { response: { status: 404 } });

// Every 400 this endpoint sends carries `detail`. The previous version of the
// test below built a bodiless one and asserted the modal's own hardcoded
// sentence -- a response the view never produces.
const alreadyPending = () =>
  Object.assign(new Error("failed"), {
    response: { status: 400, data: { detail: ALREADY_PENDING } }
  });

// `results` is consumed one entry per call, so a test can script
// fail-then-succeed without a bespoke mock per test.
function mountModal(results = []) {
  let call = 0;
  const dispatch = jest.fn(() => {
    const result = results[call++] || Promise.resolve({ data: { id: 7 } });
    return result;
  });
  return shallowMount(InvitationModal, { mocks: { $store: { dispatch } } });
}

test("an error does not survive a later success", async () => {
  // The whole bug in one test: fail, then genuinely succeed, and the message
  // from the first attempt is still there at the end. Pre-fix `error` is only
  // ever written inside a catch, so nothing in this sequence clears it.
  const wrapper = mountModal([Promise.reject(notFound())]);
  await wrapper.vm.addFriend();
  expect(wrapper.vm.error).toBe(NOT_FOUND);

  await wrapper.vm.addFriend(); // second attempt resolves

  expect(wrapper.vm.showModal).toBe(false);
  expect(wrapper.vm.error).toBe("");
});

test("a second failure replaces the first message rather than stacking", async () => {
  // Two different failures, in order. If `error` were ever appended to instead
  // of assigned, the modal would show both.
  //
  // Keyed by action, not by call index: one `addFriend()` attempt dispatches
  // twice -- `getUserIdFromEmail` and then `addFriend` -- so a positional
  // script puts the second failure on the *lookup*, and the 400 lands in the
  // wrong catch. The first version of this test read the generic message and
  // failed for that reason rather than for the one it was written for.
  const dispatch = jest.fn(action =>
    action === "getUserIdFromEmail"
      ? Promise.reject(notFound())
      : Promise.reject(alreadyPending())
  );
  const wrapper = shallowMount(InvitationModal, {
    mocks: { $store: { dispatch } }
  });

  await wrapper.vm.addFriend();
  expect(wrapper.vm.error).toBe(NOT_FOUND);

  // The lookup now succeeds, so this attempt reaches the send and fails there.
  dispatch.mockImplementation(action =>
    action === "addFriend"
      ? Promise.reject(alreadyPending())
      : Promise.resolve({ data: { id: 7 } })
  );

  await wrapper.vm.addFriend();

  // Different from NOT_FOUND, which is what this test is actually about --
  // assigned, not appended.
  expect(wrapper.vm.error).toBe(ALREADY_PENDING);
});

test("opening the modal clears a message left by an earlier attempt", async () => {
  // `open()` is what the user presses to come back -- `Home.vue:94` calls
  // `this.$refs["invitation-modal"].open()`. The failure above happens with the
  // modal open and no send after it, so the error is on screen when they close
  // it. Reopening must not still be showing it.
  const wrapper = mountModal([Promise.reject(notFound())]);
  wrapper.vm.open();
  await wrapper.vm.addFriend();
  expect(wrapper.vm.error).toBe(NOT_FOUND);

  wrapper.vm.close();
  wrapper.vm.open();

  expect(wrapper.vm.showModal).toBe(true);
  expect(wrapper.vm.error).toBe("");
});

test("a sent address does not come back when the modal is reopened", async () => {
  // The other half, and the one that costs the user a second wrong action.
  // Nothing clears `friendEmail`, so the next invite starts pre-filled with an
  // address that has already been invited -- and Send on it comes back "You
  // have already sent an invitation."
  const wrapper = mountModal();
  wrapper.vm.open();
  wrapper.vm.friendEmail = "bob@gmail.com";

  await wrapper.vm.addFriend();

  expect(wrapper.vm.showModal).toBe(false);
  expect(wrapper.vm.friendEmail).toBe("");
});

test("closing without sending does not throw the address away", async () => {
  // The guard on the fix. `close()` is a plain dismissal -- there is a Close
  // button, and clicking the overlay behind the modal closes it too -- so it
  // must not clear a half-typed address. Clearing belongs to `open()` (a fresh
  // visit) and to success, not to every close.
  const wrapper = mountModal();
  wrapper.vm.open();
  wrapper.vm.friendEmail = "half-typed";

  wrapper.vm.close();

  expect(wrapper.vm.friendEmail).toBe("half-typed");
});
