/* eslint-env jest */
/**
 * What `SendForm` puts *into the store*, which no test had ever looked at.
 *
 * **The root cause, and it is one line.** All five other SendForm specs mount it
 * with `commit: jest.fn()`. That is the right mock for a spec about the component
 * -- the box clears, the text comes back, Enter sends -- and it is exactly why
 * twenty-four mutations of this file found eighteen survivors: **every one of them
 * is only observable through a commit, and no SendForm spec has ever inspected
 * one.** The optimistic bubble's shape, the dispatch payload's `front_key`, the
 * order of the two commits, and whether the commits happen at all are all
 * invisible to a mock that records calls and asserts nothing about them.
 *
 * The other five drive `mutations.js` directly with hand-built objects --
 * `send_confirmation.spec.js:107-117` even reproduces the two commits in their
 * documented order, in its own fixture. So the *mutations* are well covered and
 * the *component that calls them* is covered by nothing. That is items 61-68's
 * subject again, one layer up: each half pins itself and neither checks the other.
 *
 * So this file mounts the real component against the real store. Nothing is
 * mocked except the two actions that would leave the building.
 *
 * **The order of the two commits is the finding worth writing down.** Three
 * comments call it load-bearing (`mutations.js:69-76`, `:143-150`, and
 * `send_confirmation.spec.js:107`), and the third of those *reproduces* the order
 * in its own fixture rather than reading it from the component -- so no test can
 * see the component change it. I measured it rather than believing it, because
 * the obvious argument is wrong: swapping them does **not** crash.
 * `mutations.js:77`'s `const inRoom = state.roomMessages[element.room] || []`
 * absorbs the missing array, and `at === -1` appends through `mergeMessages`, so
 * the bubble still appears with its clock and still gets its id on confirmation.
 *
 * What the swap actually changes is *when* the key enters `receivedMessages`:
 *
 *     committed order    after send: seen=[key]   after confirm: seen=[]
 *     swapped            after send: seen=[]       after confirm: seen=[key]
 *
 * Bubbles, ids, clocks and ownership are identical at every step -- which is
 * precisely why twenty-four mutations called it a survivor. But the swapped
 * order leaves the key behind *permanently*, which is the exact leak
 * `mutations.js:73` records as removed: "Every message a user sent therefore kept
 * one permanent reactive entry for the rest of the session." The fix was applied
 * to the mutation and the ordering that defeats it was never pinned, so swapping
 * two lines in a component would quietly reinstate it with the suite green.
 */
import Vue from "vue";
import Vuex from "vuex";
import { mount } from "@vue/test-utils";
import SendForm from "@/components/SendForm.vue";
import state from "@/store/state.js";
import mutations from "@/store/mutations.js";

Vue.use(Vuex);

// The real store. `state.js` exports a singleton and `sendingPool` is a `Map`, so
// the copy is structural and the pool is re-attached afterwards.
function freshStore() {
  const s = JSON.parse(JSON.stringify(state));
  s.sendingPool = new Map();
  const sent = [];
  const writing = [];
  const store = new Vuex.Store({
    state: s,
    mutations,
    actions: {
      // Only the two actions that would otherwise leave the building. The
      // payload is recorded rather than discarded: `front_key` is the one key the
      // component can forget, and the action's conditional spread (item 95's A14)
      // is the other half of that contract.
      sendMessage: (_, payload) => {
        sent.push(payload);
        return Promise.resolve({ data: { id: 42 } });
      },
      postWriting: (_, room) => {
        writing.push(room);
        return Promise.resolve();
      }
    }
  });
  return { store, sent, writing };
}

// `selectedRoom` is set *before* the mount, and that ordering is load-bearing for
// the fixture rather than incidental: assigning it afterwards trips the `room`
// watcher, which clears `body`, so a `setData` that landed first would be wiped on
// the next tick. Every other SendForm spec starts the store with `selectedRoom: 7`
// and so never meets this -- it cost this file two debugging rounds.
function mountForm(store) {
  store.state.selectedRoom = 7;
  store.commit("SET_ROOMS", [{ id: 7 }]);
  return mount(SendForm, { store, attachTo: document.body });
}

// What `models.py:60` pushes back to every participant, the sender included.
const fromServer = front_key => ({
  id: 42,
  room: 7,
  body: "hi",
  is_owner: true,
  timestamp: "2026-01-01T10:00:00Z",
  front_key,
  all_received: false,
  all_read: false
});

const bubbles = store => store.state.roomMessages[7] || [];
const typingFor = (writing, room) => writing.filter(one => one === room);

describe("the message you type is in the store before the server answers", () => {
  test("it is on screen, on your side, and still on its clock", async () => {
    const { store } = freshStore();
    const wrapper = mountForm(store);
    wrapper.setData({ body: "hi" });
    await wrapper.vm.$nextTick();

    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();

    // `sending: true` is what draws the clock (`SentMessage.vue:16`), and
    // `is_owner: true` is what keeps it on the right-hand side. The optimistic
    // object deliberately carries no `author`, so `is_owner` is also the only
    // thing stopping `ReceivedMessage.vue`'s unguarded author dereference from
    // emptying the chat subtree.
    expect(bubbles(store)).toHaveLength(1);
    const [sent] = bubbles(store);
    expect(sent.body).toBe("hi");
    expect(sent.is_owner).toBe(true);
    expect(sent.sending).toBe(true);
    // No id yet: it is the server's to give, which is why `front_key` exists.
    expect(sent.id).toBeUndefined();

    wrapper.destroy();
  });

  test("the key that ties it to the server's copy leaves with it", async () => {
    const { store, sent } = freshStore();
    const wrapper = mountForm(store);
    wrapper.setData({ body: "hi" });
    await wrapper.vm.$nextTick();

    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();

    // One key, present on *both* halves. They have to be the same value: the
    // bubble is pooled under the one and the server's copy is matched on the
    // other, so a send that keys only one of them can never be confirmed.
    const key = bubbles(store)[0].front_key;
    expect(key).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ room: 7, body: "hi", front_key: key });

    wrapper.destroy();
  });

  test("the composer is ready for the next one", async () => {
    // One assertion, and it is here rather than in a spec of its own because it
    // needs the same real mount -- `.focus()` on a detached node is a no-op in
    // jsdom, which is why `attachTo` is in the helper.
    const { store } = freshStore();
    const wrapper = mountForm(store);
    wrapper.setData({ body: "hi" });
    await wrapper.vm.$nextTick();

    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(wrapper.find("textarea").element);

    wrapper.destroy();
  });
});

describe("the server's copy takes the message's place", () => {
  // One lifecycle, run twice per test -- `send()` returns the bubble so both
  // halves work from the same key rather than each minting its own.
  const send = async store => {
    const wrapper = mountForm(store);
    wrapper.setData({ body: "hi" });
    await wrapper.vm.$nextTick();
    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();
    return { wrapper, key: bubbles(store)[0].front_key };
  };

  test("one bubble survives, carrying the server's id", async () => {
    const { store } = freshStore();
    const { wrapper, key } = await send(store);

    mutations.LINK_MESSAGES_TO_ROOM(store.state, [fromServer(key)]);
    await wrapper.vm.$nextTick();

    // Two bubbles here would be the silent defect: `mergeMessages` dedupes on
    // `front_key`, so a bubble and a dispatched key that disagree never meet.
    expect(bubbles(store)).toHaveLength(1);
    expect(bubbles(store)[0].id).toBe(42);
    expect(bubbles(store)[0].sending).toBeUndefined();

    wrapper.destroy();
  });

  test("the message leaves nothing behind in either set", async () => {
    // The assertion the swap survives to fail. `sendingPool` is the in-flight
    // set; `receivedMessages` is the already-seen filter. Both are keyed by
    // `front_key` and both have to be empty once the message has landed --
    // `receivedMessages` especially, because a leftover entry there drops the
    // matching push as already-seen, and grows without bound.
    const { store } = freshStore();
    const { wrapper, key } = await send(store);

    mutations.LINK_MESSAGES_TO_ROOM(store.state, [fromServer(key)]);
    await wrapper.vm.$nextTick();

    expect([...store.state.sendingPool.keys()]).toEqual([]);
    expect(key in store.state.receivedMessages).toBe(false);
    expect(Object.keys(store.state.receivedMessages)).toEqual([]);

    wrapper.destroy();
  });
});

describe("nothing is sent that should not be", () => {
  test("no chat open, no send", async () => {
    // `state.js:3` starts `selectedRoom` at `null` and `Rooms.vue:22` mounts one
    // SendForm for the whole session, so this is the state of the composer in the
    // moment between loading and clicking somebody. The button only *looks*
    // disabled -- it is a `type="button"` with no `:disabled` -- so the guard in
    // `sendMessage` is the only thing standing between the composer and a POST
    // carrying `room: null`, plus an optimistic bubble filed under `roomMessages`
    // of no room at all.
    const { store, sent } = freshStore();
    const wrapper = mountForm(store);
    // Deselect, then *let the watcher run*, then type. The other order bails on
    // the wrong guard: the watcher clears `body` on the way past, so the send
    // would find nothing to send and this test would pass with the room guard
    // deleted -- which is the whole thing it exists to catch.
    store.state.selectedRoom = null;
    await wrapper.vm.$nextTick();
    wrapper.setData({ body: "hi" });
    await wrapper.vm.$nextTick();

    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();

    expect(sent).toEqual([]);
    expect(store.state.roomMessages[7]).toBeUndefined();
    // And the text is still there to send, rather than consumed by a no-op.
    expect(wrapper.vm.body).toBe("hi");

    wrapper.destroy();
  });

  test("whitespace is not a message", async () => {
    // The other half of the same guard. `Message.body` is a `TextField` with
    // `allow_blank=False`, so DRF refuses a blank body with a 400 -- meaning a
    // spaces-only send paints a bubble, clears the box, and then takes the
    // bubble back down, which is the same blink `send_form_maxlength.spec.js`
    // documents for an over-long body.
    const { store, sent } = freshStore();
    const wrapper = mountForm(store);
    wrapper.setData({ body: "   " });
    await wrapper.vm.$nextTick();

    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();

    expect(sent).toEqual([]);
    expect(bubbles(store)).toEqual([]);
    expect(wrapper.vm.body).toBe("   ");

    wrapper.destroy();
  });
});

describe("the typing indicator is announced, not shouted", () => {
  // The receiving half of this indicator is well covered -- `user_writing_
  // listener.spec.js` pins `User.vue`'s subscription, its cleanup and its
  // unguarded-author defect. The sending half was not covered at all: five
  // mutations of `throttleFunction` and its two call sites all survived.
  //
  // `postWriting` is a POST. Unthrottled it is one per keystroke; and the timer
  // never reopening is worse than either -- `timerId` stays truthy for the rest
  // of the session, so the indicator stops working entirely after your first
  // keystroke and no test notices, because every spec types once.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const type = async (wrapper, body) => {
    wrapper.setData({ body });
    await wrapper.vm.$nextTick();
  };

  test("a burst of typing is one announcement", async () => {
    const { store, writing } = freshStore();
    const wrapper = mountForm(store);

    await type(wrapper, "h");
    await type(wrapper, "he");
    await type(wrapper, "hel");

    expect(typingFor(writing, 7)).toHaveLength(1);

    wrapper.destroy();
  });

  test("and it starts again once the window closes", async () => {
    const { store, writing } = freshStore();
    const wrapper = mountForm(store);

    await type(wrapper, "h");
    jest.advanceTimersByTime(10000);
    await type(wrapper, "he");

    expect(typingFor(writing, 7)).toHaveLength(2);

    wrapper.destroy();
  });

  test("sending re-arms it, so the next message is announced too", async () => {
    // `sendMessage` nulls `timerId` so a send counts as activity. Without it the
    // window that was opened by the text you just sent swallows the text you type
    // next, and the peer stops seeing you type until you pause for ten seconds.
    const { store, writing } = freshStore();
    const wrapper = mountForm(store);

    await type(wrapper, "first");
    wrapper.vm.sendMessage();
    await wrapper.vm.$nextTick();
    await type(wrapper, "second");

    expect(typingFor(writing, 7)).toHaveLength(2);

    wrapper.destroy();
  });

  test("switching chats re-arms it, and never announces one", async () => {
    // Both halves of the `room` watcher, which is two lines and neither was
    // pinned. `timerId = null` stops the previous chat's window from silencing
    // the new one -- the draft beside it is pinned three ways already in
    // `send_form_draft_room_change.spec.js`, so this is the untested half of a
    // watcher that is otherwise covered.
    const { store, writing } = freshStore();
    const wrapper = mountForm(store);

    await type(wrapper, "for bob");
    store.state.selectedRoom = 8;
    await wrapper.vm.$nextTick();
    await type(wrapper, "for carol");

    // Two rooms announced, one each -- so the window really did reopen.
    expect(writing).toEqual([7, 8]);

    wrapper.destroy();
  });

  test("typing with no chat open announces nothing", async () => {
    // The `&& this.room` half of the watcher. `postWriting(undefined)` is a POST
    // to `/api/v1/rooms/undefined/writing`.
    const { store, writing } = freshStore();
    const wrapper = mountForm(store);
    store.state.selectedRoom = null;
    await wrapper.vm.$nextTick();

    await type(wrapper, "into the void");

    expect(writing).toEqual([]);

    wrapper.destroy();
  });
});