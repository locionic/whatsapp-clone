/* eslint-env jest */
/**
 * What the "add a friend" modal says when it cannot add a friend.
 *
 * The bug this pins: both catch blocks read `error.response.status`. Axios only
 * sets `response` when the server actually replied - for anything that stopped
 * the request short of a reply (server down, DNS failure, connection refused,
 * CORS) it is undefined, and verified against the installed axios 0.19.0:
 * ECONNREFUSED gives `response === undefined`. So the line meant to describe the
 * failure threw a TypeError *inside the catch block*, which escaped the method
 * as an unhandled rejection and left `error` empty.
 *
 * The symptom is the same one item 8 was filed for in the profile form, reached
 * by the one path item 8's fix does not cover: `this.error` is only ever
 * assigned inside the catch, so if the catch throws, the modal shows no message
 * at all and looks like nothing happened - on the only screen where the user's
 * next action is to press Send again.
 */
import { shallowMount } from "@vue/test-utils";
import InvitationModal from "@/components/invitations/InvitationModal.vue";

const GENERIC = "An error has occurred. Please try again later.";

// What axios actually rejects with when the request never got a reply: a plain
// Error carrying `code` and `request`, and no `response`.
const noReplyFromServer = () =>
  Object.assign(new Error("Network Error"), {
    code: "ERR_NETWORK",
    request: {}
  });

const statusFromServer = (code, data) =>
  Object.assign(new Error("failed"), { response: { status: code, data } });

function mountModal({ fail, error }) {
  const dispatch = jest.fn(action =>
    action === fail
      ? Promise.reject(error)
      : Promise.resolve({ data: { id: 1 } })
  );
  return shallowMount(InvitationModal, { mocks: { $store: { dispatch } } });
}

// The three refusals `POST /friends/add/{id}` can answer, with the bodies it
// actually sends. Measured against the view, not assumed -- see
// `test_each_refusal_carries_its_own_reason` in
// `friends/_tests/test_friendship_api.py`, which pins the same three.
const ALREADY_PENDING = "Friendship request already exists.";
const ALREADY_FRIENDS = "The users are already friends.";
const YOURSELF = ["Users cannot be friends with themselves"];

test("an unreachable server still says something went wrong", async () => {
  // `resolves` is half the assertion. Pre-fix the method rejected with the
  // TypeError, so a bare `await` would fail here before ever checking the text.
  const wrapper = mountModal({
    fail: "getUserIdFromEmail",
    error: noReplyFromServer()
  });

  await expect(wrapper.vm.addFriend()).resolves.toBeUndefined();

  expect(wrapper.vm.error).toBe(GENERIC);
});

test("an unreachable server is handled the same way on the send", async () => {
  // The same dereference, in the second catch. The first dispatch succeeds and
  // returns a user id, so this reaches the block that sends the invitation.
  const wrapper = mountModal({ fail: "addFriend", error: noReplyFromServer() });

  await expect(wrapper.vm.addFriend()).resolves.toBeUndefined();

  expect(wrapper.vm.error).toBe(GENERIC);
});

test("a 404 still names the problem", async () => {
  // Guards against "fixing" the dereference by throwing all the detail away.
  const wrapper = mountModal({
    fail: "getUserIdFromEmail",
    error: statusFromServer(404)
  });

  await wrapper.vm.addFriend();

  expect(wrapper.vm.error).toBe("User not found.");
});

test.each([
  ["an invitation already pending", ALREADY_PENDING],
  ["the target already a friend", ALREADY_FRIENDS],
  ["your own address", YOURSELF]
])(
  "a 400 saying %s is reported as that, not as a pending invite",
  async (_case, detail) => {
    // All three refusals are the same status. The modal used to answer every
    // one of them with "You have already sent an invitation.", so two of them
    // told the user something that had not happened to them -- you cannot have
    // sent yourself an invitation, and being friends with someone is not a
    // pending ask. The reason is in the response body; the status cannot say it.
    const wrapper = mountModal({
      fail: "addFriend",
      error: statusFromServer(400, { detail })
    });

    await wrapper.vm.addFriend();

    expect(wrapper.vm.error).toBe(Array.isArray(detail) ? detail[0] : detail);
    expect(wrapper.vm.error).not.toBe("You have already sent an invitation.");
  }
);

test("a 400 with no reason in it falls back rather than showing nothing", async () => {
  // The fallback is what keeps this from trading a wrong sentence for an
  // empty one. A 500 carries no `detail`, and a proxy in front of the app
  // answers with its own HTML.
  const wrapper = mountModal({
    fail: "addFriend",
    error: statusFromServer(500)
  });

  await wrapper.vm.addFriend();

  expect(wrapper.vm.error).toBe(GENERIC);
});

test("the modal stays open when the send fails", async () => {
  // Closing is what `addFriend` does on success. If the failure path ever
  // reached that line, the user would lose the dialog *and* the explanation.
  const wrapper = mountModal({
    fail: "addFriend",
    error: noReplyFromServer()
  });
  wrapper.vm.showModal = true;

  await wrapper.vm.addFriend();

  expect(wrapper.vm.showModal).toBe(true);
});
