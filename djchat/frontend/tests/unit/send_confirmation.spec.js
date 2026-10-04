/* eslint-env jest */
/**
 * The third link in the `front_key` chain, which had never been followed to the
 * screen.
 *
 * Two of the three links were already pinned, by two different items, and
 * neither of them noticed the gap between them:
 *
 *     SendForm.vue:66   let front_key = uuid4()
 *     actions.js:76     ...(front_key ? { front_key } : {})      item 69
 *     POST /messages/   the serializer keeps the key             item 54
 *     models.py:60      signal_to_room, to *all* participants
 *     mutations.js:42   if (state.sendingPool.has(front_key)) {
 *       was:               delete message.sending        <- removed by this item
 *       was:               Object.assign(message, element) <- removed by this item
 *     SentMessage.vue:16 v-if="message.sending"
 *
 * Item 69 pinned the key leaving the browser; item 54 pinned the server keeping
 * it. Nothing pinned what the third link is *for*: the server's copy taking the
 * place of the optimistic bubble and clearing its clock. `models.py:60`
 * iterates `room.participants.all()`, which contains the sender, so that push
 * really does arrive - the branch runs on every message, every time.
 *
 * The existing tests cover the branch's *state* and never its *render*:
 * `room_message_order.spec.js:139` and `failed_send.spec.js:73` both assert
 * `receivedMessages` loses the key, on a plain state object. Nothing had
 * rendered a message that was mid-send, so that branch had never been observed
 * to do anything a person could see.
 *
 * **This file mounts `MessagesSection`, not `SentMessage`, and that is the whole
 * point of it.** The obvious fixture - mount the bubble, mutate the object,
 * assert the icon - passes against code that is broken, and it passes for a
 * reason worth writing down. Vue 2 notifies `message.__ob__.dep` when you
 * `delete` from or `Object.assign` onto an observed object, but a watcher that
 * read `message.sending` subscribed to *that key's* dep, not to the object's. And
 * when the parent does re-render, `shouldUpdateComponent` compares props by
 * identity, sees the same object, and skips the child. So a bubble mounted on
 * its own can never notice, whichever of the two spellings is used, and the only
 * thing that reaches it is a *different object* arriving as a prop. That is
 * `MessagesSection.vue:89`'s `v-for` re-run - so that is where this is mounted,
 * and the fix is expected to show up there too.
 */
import Vue from "vue";
import { mount } from "@vue/test-utils";
import mutations from "@/store/mutations.js";
import MessagesSection from "@/components/messages/MessagesSection.vue";

// The two objects, built exactly as `SendForm.vue:66-76` and then as the socket
// delivers the server's copy. The optimistic one has no `id` - that is the
// point of the key, and it is why `position()` at `mutations.js:15` calls it
// `Infinity`.
const optimistic = () => ({
  room: 7,
  body: "hi",
  is_owner: true,
  sending: true,
  timestamp: "2026-01-01T10:00:00Z",
  front_key: "key-a"
});

const fromServer = () => ({
  id: 42,
  room: 7,
  body: "hi",
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  front_key: "key-a",
  all_received: false,
  all_read: false
});

// An older message already in the room, so the confirmation is replacing *one*
// bubble in a room that has a history rather than being the only thing in it.
// Not the owner's, so it renders as `ReceivedMessage` and contributes no
// read-receipt icons to `sentIcons` below.
const earlier = () => ({
  id: 1,
  room: 7,
  body: "earlier",
  is_owner: false,
  timestamp: "2026-01-01T09:00:00Z",
  front_key: "key-0",
  // A user *id*, not a nested author: `ReceivedMessage.vue:47-51` resolves it
  // against `state.users` itself. An incoming message whose author is not in
  // that map does not render at all - `getUser` is undefined and `getColor`
  // dereferences it unguarded - and the render error surfaces as an empty
  // subtree rather than a failing test, which is the failure mode
  // `messages_section_no_selection.spec.js` exists to document.
  author: 9
});

// `Vue.observable`, for item 70's reason: the subject here is a change to a
// value that already exists, and a plain object cannot notify anyone of it.
const openChat = () =>
  Vue.observable({
    selectedRoom: 7,
    sendingPool: new Map(),
    receivedMessages: {},
    roomMessages: {},
    unreadMessages: {},
    users: { 9: { id: 9, username: "Bob", email: "bob@example.com" } },
    allReceived: {},
    allRead: {},
    rooms: { 7: { id: 7, group_name: "Bob" } }
  });

// The two commits `SendForm` makes, in its order (:74 then :75), on one shared
// object. Two literals would make the `sendingPool` lookup miss - the branch
// reaches through `front_key` to a pooled object - so a spec that rebuilt the
// bubble would skip the very code it came to test.
const optimisticSend = state => {
  mutations.LINK_MESSAGES_TO_ROOM(state, [earlier()]);
  const bubble = optimistic();
  mutations.LINK_MESSAGES_TO_ROOM(state, [bubble]);
  mutations.ADD_MESSAGE_TO_SENDING(state, bubble);
  return bubble;
};

const mountChat = state =>
  mount(MessagesSection, {
    mocks: {
      $store: {
        state,
        commit: jest.fn(),
        // Never settles: the watchers must not fetch anything here.
        dispatch: jest.fn(() => new Promise(() => {}))
      }
    }
  });

// The sent bubble's own icons. Three `.material-icons` exist in the subtree and
// only one component carries them, so the class is specific - same selector
// `read_receipts.spec.js` and `receipt_reactivity.spec.js` use.
const sentIcons = wrapper =>
  wrapper
    .findAll(".sent-message .material-icons")
    .wrappers.map(one => one.text());

beforeAll(() => {
  // jsdom has no layout, so `Element.scrollTo` is absent and `mounted()` reaches it.
  window.Element.prototype.scrollTo = jest.fn();
});

test("a message waiting on the server is on its clock", () => {
  // The starting condition, so the failure below cannot be "it was never on a
  // clock in the first place".
  const state = openChat();
  optimisticSend(state);

  expect(sentIcons(mountChat(state))).toEqual(["access_time"]);
});

test("the server's copy takes the message off its clock", async () => {
  const state = openChat();
  optimisticSend(state);
  const wrapper = mountChat(state);
  expect(sentIcons(wrapper)).toEqual(["access_time"]);

  mutations.LINK_MESSAGES_TO_ROOM(state, [fromServer()]);
  await wrapper.vm.$nextTick();

  // **The store is already right.** Asserted before the screen so the failure
  // below can only be a failure to *tell anyone* - not "the branch never ran"
  // and not "the merge lost the id". Those are different bugs with different
  // fixes, and a test that only checked the icon could not tell them apart.
  expect(state.sendingPool.has("key-a")).toBe(false);
  // By key rather than by position. Indexing `[1]` would make this test fail
  // with a TypeError under *any* change to the room's length - including the
  // one the next test exists to catch - and a failure that cannot be told
  // apart from another test's is not evidence of anything.
  expect(state.roomMessages[7].find(one => one.front_key === "key-a").id).toBe(
    42
  );

  // One tick, not two: the server's copy says `all_received: false`. The tick
  // turning green is item 66's business; this is the icon changing at all.
  expect(sentIcons(wrapper)).toEqual(["done"]);
});

test("the confirmed message replaces its optimistic twin, not the room's history", async () => {
  // The other half, and the reason the fix cannot just be a notification.
  // `mergeMessages` dedupes on `front_key` with the *incoming* copy winning, so
  // one bubble survives the confirmation rather than the optimistic one and the
  // server's one sitting side by side - and the room's other message is carried
  // through untouched.
  //
  // The `earlier()` message in the fixture is what makes this isolable. With a
  // room holding only the message being confirmed, a fix that replaced the
  // array with `[element]` would pass this test *and* the one above, while
  // silently emptying the chat. Two messages in, two messages out, and the
  // second is the server's.
  const state = openChat();
  optimisticSend(state);
  const wrapper = mountChat(state);
  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, undefined]);

  mutations.LINK_MESSAGES_TO_ROOM(state, [fromServer()]);
  await wrapper.vm.$nextTick();

  expect(state.roomMessages[7].map(m => m.id)).toEqual([1, 42]);
  expect(wrapper.findAll(".sent-message")).toHaveLength(1);
  // And the room's history is still on screen, not just in the store.
  expect(wrapper.text()).toContain("earlier");
});

test("two messages in flight at once both get a clock", () => {
  // `MessagesSection.vue:89` keys the v-for on `:key="message.id"`, and an
  // optimistic message has no `id` - that is the whole reason `front_key`
  // exists. So while two sends are outstanding their keys are both `undefined`.
  // Item 71 only ever had one in flight, so this has never been exercised.
  //
  // The store is expected to be fine either way: `mergeMessages` keys on
  // `front_key`, which both of these have, and `position()` gives them both
  // `Infinity`, whose difference is `NaN` - which `Array.sort` reads as "equal",
  // so a stable sort leaves them in the order they were typed.
  const state = openChat();
  optimisticSend(state);

  const second = optimistic();
  second.front_key = "key-b";
  second.body = "again";
  mutations.LINK_MESSAGES_TO_ROOM(state, [second]);
  mutations.ADD_MESSAGE_TO_SENDING(state, second);

  expect(state.roomMessages[7]).toHaveLength(3);

  const wrapper = mountChat(state);
  expect(wrapper.findAll(".sent-message")).toHaveLength(2);
  expect(sentIcons(wrapper)).toEqual(["access_time", "access_time"]);
  expect(wrapper.text()).toContain("hi");
  expect(wrapper.text()).toContain("again");
});

test("confirming one of two in flight keeps the order they were typed", async () => {
  // Item 72 recorded this failing the other way round, and the cause was item
  // 71's own fix rather than anything older. `mergeMessages` re-sorts, and
  // `position()` at `mutations.js:15` gives a message with no id `Infinity`, so
  // confirming "again" lifted it above the "hi" typed before it. The original
  // in-place code never re-sorted and therefore never had the problem; making
  // it reactive by sorting was the wrong way round.
  //
  // I also expected the duplicate `undefined` keys to mis-patch here.
  // Measured, twice: they do not. Mount tolerates them, and by the time the
  // patch runs only one node is left without an id. So `:key="message.id"` is
  // left alone and this test pins the conclusion, not the failure I expected.
  const state = openChat();
  optimisticSend(state);
  const second = optimistic();
  second.front_key = "key-b";
  second.body = "again";
  mutations.LINK_MESSAGES_TO_ROOM(state, [second]);
  mutations.ADD_MESSAGE_TO_SENDING(state, second);

  const wrapper = mountChat(state);

  const confirmed = fromServer();
  confirmed.front_key = "key-b";
  confirmed.body = "again";
  mutations.LINK_MESSAGES_TO_ROOM(state, [confirmed]);
  await wrapper.vm.$nextTick();

  const bodies = wrapper.findAll(".received-message, .sent-message");
  expect(bodies).toHaveLength(3);
  // Typed order, so the still-pending "hi" keeps its slot and the confirmed
  // "again" takes the one below it rather than jumping the queue.
  expect(state.roomMessages[7].map(one => one.id)).toEqual([1, undefined, 42]);
  expect(bodies.at(1).text()).toContain("hi");
  expect(bodies.at(2).text()).toContain("again");
  // And the icons follow their messages rather than staying put in place.
  expect(sentIcons(wrapper)).toEqual(["access_time", "done"]);
});

test("once both land, the order is the order they were typed", async () => {
  // The other half, and the reason this is recorded rather than fixed. The
  // scramble above is transient: ids are assigned in POST order, so when the
  // straggler finally confirms it takes its proper place and the thread reads
  // correctly again. Without this, the previous test reads as a permanent bug.
  const state = openChat();
  optimisticSend(state);
  const second = optimistic();
  second.front_key = "key-b";
  second.body = "again";
  mutations.LINK_MESSAGES_TO_ROOM(state, [second]);
  mutations.ADD_MESSAGE_TO_SENDING(state, second);

  const wrapper = mountChat(state);

  // "again" is confirmed first, out of POST order - the case that scrambles.
  const first = fromServer();
  first.front_key = "key-b";
  first.body = "again";
  first.id = 43;
  mutations.LINK_MESSAGES_TO_ROOM(state, [first]);
  await wrapper.vm.$nextTick();

  const late = fromServer();
  late.front_key = "key-a";
  late.body = "hi";
  late.id = 42;
  mutations.LINK_MESSAGES_TO_ROOM(state, [late]);
  await wrapper.vm.$nextTick();

  expect(state.roomMessages[7].map(one => one.id)).toEqual([1, 42, 43]);
  const bodies = wrapper.findAll(".received-message, .sent-message");
  expect(bodies.at(1).text()).toContain("hi");
  expect(bodies.at(2).text()).toContain("again");
  expect(sentIcons(wrapper)).toEqual(["done", "done"]);
});
