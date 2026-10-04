/* eslint-env jest */
/**
 * A message the server refused.
 *
 * The defect: `SendForm.sendMessage` commits the optimistic message and adds it
 * to `sendingPool` *before* dispatching, and the dispatch had no `.catch`. So a
 * rejected POST left the message in `roomMessages` with `sending: true` and in
 * the sending pool forever -- `SentMessage.vue:16` and `User.vue:43` both draw an
 * `access_time` clock off that flag, so the bubble sat in the thread and in the
 * room list claiming to still be on its way, with nothing left to move it. No
 * error, no bubble, no event: the user had no idea the message had not gone.
 *
 * A rejection is reachable, not theoretical -- a peer removes you from the room
 * between the render and the click (403), the body trips a validator (400), the
 * database hiccups (500), or the request is dropped on the way out.
 */
import { mount } from "@vue/test-utils";
import mutations from "@/store/mutations.js";
import SendForm from "@/components/SendForm.vue";

function freshState() {
  return {
    rooms: {},
    users: {},
    roomMessages: {},
    receivedMessages: {},
    sendingPool: new Map()
  };
}

// What SendForm does on every send: commit the optimistic message, then put it
// in the sending pool. The order matters and is not incidental -- the second
// test is entirely about it.
function beginSend(state, front_key, room = 7) {
  const message = {
    room,
    body: "typed",
    is_owner: true,
    sending: true,
    front_key
  };
  mutations.LINK_MESSAGES_TO_ROOM(state, [message]);
  mutations.ADD_MESSAGE_TO_SENDING(state, message);
  return message;
}

function failSend(state, message) {
  mutations.REMOVE_FAILED_MESSAGE(state, {
    front_key: message.front_key,
    room: message.room
  });
}

test("a message the server refused stops claiming to still be sending", () => {
  const state = freshState();
  const sent = beginSend(state, "key-a");
  const earlier = { id: 1, room: 7, body: "earlier", front_key: "key-1" };
  mutations.LINK_MESSAGES_TO_ROOM(state, [earlier]);

  failSend(state, sent);

  expect(state.roomMessages[7].map(m => m.front_key)).toEqual(["key-1"]);
  expect(state.sendingPool.has("key-a")).toBe(false);
});

test("the message the server sent anyway is still allowed to arrive", () => {
  // The subtle half. `SendForm` commits LINK_MESSAGES_TO_ROOM *before*
  // ADD_MESSAGE_TO_SENDING, so the optimistic message misses the sendingPool
  // branch, takes the else-branch, and registers its `front_key` in
  // `receivedMessages` -- the store's already-seen-this set.
  const state = freshState();
  const sent = beginSend(state, "key-a");
  expect("key-a" in state.receivedMessages).toBe(true); // the hazard, set up

  failSend(state, sent);
  expect("key-a" in state.receivedMessages).toBe(false);

  // A POST can reach the server and still reject the client: the response is
  // lost on the way back. The message exists, the peer got it, the push fires.
  // If rolling back left that registration in place, LINK_MESSAGES_TO_ROOM would
  // drop the push as already-seen -- and the sender's copy of a message the
  // whole conversation has would be silently swallowed. Removing the optimistic
  // bubble is what makes this reachable, so it is what the fix has to undo.
  mutations.LINK_MESSAGES_TO_ROOM(state, [
    { id: 9, room: 7, body: "typed", front_key: "key-a" }
  ]);
  expect(state.roomMessages[7].map(m => m.id)).toEqual([9]);
});

describe("the text you typed is still there after a refusal", () => {
  // Only the send is refused. The `body` watcher also dispatches (`postWriting`,
  // the typing indicator), and rejecting that too would be the mock inventing a
  // failure the component does not handle.
  const mountForm = () =>
    mount(SendForm, {
      mocks: {
        $store: {
          state: { selectedRoom: 7 },
          commit: jest.fn(),
          dispatch: jest.fn(action =>
            action === "sendMessage"
              ? Promise.reject(new Error("403"))
              : Promise.resolve()
          )
        }
      }
    });

  test("a refused send puts it back in the box", async () => {
    const wrapper = mountForm();
    wrapper.setData({ body: "hello" });

    wrapper.vm.sendMessage();
    // Cleared straight away: the send was meant to look like it had gone.
    expect(wrapper.vm.body).toBe("");

    await Promise.resolve();
    await Promise.resolve();

    expect(wrapper.vm.body).toBe("hello");
  });

  test("it does not overwrite what you have typed since", async () => {
    // The refusal takes a round trip. Whatever is in the box by then is newer
    // and wanted; clobbering it would lose a second message to fix the first.
    const wrapper = mountForm();
    wrapper.setData({ body: "hello" });

    wrapper.vm.sendMessage();
    wrapper.setData({ body: "and also" });

    await Promise.resolve();
    await Promise.resolve();

    expect(wrapper.vm.body).toBe("and also");
  });
});
