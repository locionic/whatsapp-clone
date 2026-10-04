/* eslint-env jest */

/**
 * The unread axis: three mutations, and until this file not one of them had
 * ever been executed by any test. `mutations.js` sits at 33% function coverage
 * and `actions.js` at 3.85%, so `ADD_UNREAD_MESSAGES` and the two removals --
 * the only things that ever move the badge -- were all unrun.
 *
 * That matters more than an average uncovered mutation, because three separate
 * components read this one map and all of them compare **strictly**:
 *
 *     User.vue:169        Object.values(unreadMessages)
 *                              .filter(el => el === this.room.id).length
 *     MessagesSection:202 Object.values(unreadMessages).includes(selectedRoom)
 *     SentMessage:78      this.message.id in unreadMessages
 *
 * `===` means the value stored here has to be the same *type* as `room.id`.
 * Both come off the server as JSON numbers, so they are -- but a change that
 * made either a string would empty the badge on a live app and leave nothing
 * in the console. There is no error to notice.
 *
 * The shape itself crosses a language boundary and nothing ties the two ends
 * together: `ADD_UNREAD_MESSAGES` reads `element.id` and `element.room`, and
 * `UnreadMessageSerializer` (chat/api/serializers.py) declares exactly
 * `('id', 'room')`. Django's half is pinned by `test_message_api.py`; these
 * are the client half -- the same shape item 42 found unwired for the
 * websocket URL.
 *
 * No store, no axios, no mounting: the mutations are plain functions over
 * plain state, which is how `room_message_order.spec.js` and
 * `failed_send.spec.js` drive them, and it keeps the assertions about the
 * mutations rather than about Vue's reactivity.
 */
import mutations from "@/store/mutations.js";

function freshState() {
  return {
    rooms: {},
    users: {},
    roomMessages: {},
    receivedMessages: {},
    unreadMessages: {},
    sendingPool: new Map()
  };
}

test("the badge counts one room's messages and not another's", () => {
  // What GET /api/v1/messages/unread actually returns, and the arithmetic
  // User.vue does on it verbatim.
  const state = freshState();
  mutations.ADD_UNREAD_MESSAGES(state, [
    { id: 10, room: 7 },
    { id: 11, room: 7 },
    { id: 12, room: 9 }
  ]);

  const badgeFor = roomId =>
    Object.values(state.unreadMessages).filter(el => el === roomId).length;

  expect(badgeFor(7)).toBe(2);
  expect(badgeFor(9)).toBe(1);
  expect(badgeFor(11)).toBe(0); // a message id is not a room id
});

test("reading one message takes that message off and leaves the rest", () => {
  // SentMessage.vue / ReceivedMessage.vue: `message.id in unreadMessages`
  // draws the single tick, so a removal that took too much with it would mark
  // every other message in the thread as read too.
  const state = freshState();
  mutations.ADD_UNREAD_MESSAGES(state, [
    { id: 10, room: 7 },
    { id: 11, room: 7 }
  ]);
  mutations.REMOVE_MESSAGE_FROM_UNREAD(state, 10);

  expect(10 in state.unreadMessages).toBe(false);
  expect(11 in state.unreadMessages).toBe(true);
});

test("opening a room clears that room's badge without clearing another's", () => {
  // MessagesSection's `selectedRoom` watcher: hasUnreadMessagesInRoom() is a
  // strict `includes(selectedRoom)`, and REMOVE_ROOM_MESSAGES_FROM_UNREAD
  // compares the same way. Off-by-one key handling here takes the badge off a
  // chat you have not opened, and there is nothing to report it.
  const state = freshState();
  // Written straight in rather than through ADD_UNREAD_MESSAGES, so this test
  // is about REMOVE_ROOM_MESSAGES_FROM_UNREAD alone. Built through the other
  // mutation it also fails whenever that one is broken, which is two
  // mutations' worth of signal from one re and no way to tell them apart.
  state.unreadMessages = { 10: 7, 11: 7, 12: 9 };
  mutations.REMOVE_ROOM_MESSAGES_FROM_UNREAD(state, 7);

  expect(Object.values(state.unreadMessages)).toEqual([9]);
});

test("a re-fetch rebuilds the badge from the server instead of merging", () => {
  // App.vue dispatches fetchUnreadMessages on every `update` push, so this
  // mutation runs over and over in a session. It replaces rather than merges,
  // which is the only reason a message you just read stops coming back.
  const state = freshState();
  mutations.ADD_UNREAD_MESSAGES(state, [
    { id: 10, room: 7 },
    { id: 11, room: 7 }
  ]);
  mutations.ADD_UNREAD_MESSAGES(state, [{ id: 11, room: 7 }]);

  expect(Object.keys(state.unreadMessages)).toEqual(["11"]);
});

test("an empty answer clears the badge rather than leaving the last count up", () => {
  // This is the reachable form of "no unread messages": the endpoint returns
  // `[]`, and because the mutation resets before repopulating, an empty list
  // lands as an empty badge. A merge-instead would strand the count from the
  // previous fetch, which is the same failure the re-fetch test above covers
  // from the other side.
  //
  // The `if (messages)` guard is *not* what this exercises -- it is there for
  // a null body, which no endpoint produces here, so that branch is dead
  // weight in the same way `SET_SENT_INVITATIONS`'s is. Not pinned.
  const state = freshState();
  mutations.ADD_UNREAD_MESSAGES(state, [{ id: 10, room: 7 }]);
  mutations.ADD_UNREAD_MESSAGES(state, []);

  expect(state.unreadMessages).toEqual({});
});