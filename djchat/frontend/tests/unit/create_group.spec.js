/* eslint-env jest */
/**
 * `POST /api/v1/rooms/` has no caller.
 *
 * `RoomViewSet.create` and `CreateRoomSerializer` have been wired and tested
 * from the start - `chat/_tests/test_room_api.py` posts to `room-list` seven
 * ways - and `store/actions.js` POSTs to `/rooms/{id}/writing`, `/read` and
 * `/delete`, and nowhere else. Nothing in the app can make a group, which is
 * the one room kind you can only get by asking for one: a private room appears
 * the moment somebody who already knows you messages you, and a group appears
 * the moment somebody adds you. So the kind carrying the most server-side logic
 * - the participant count, the distinct-count fix, the name check, the
 * `update_rooms` push - is the kind the client cannot produce at all.
 *
 * These two files are the whole feature: an action, and the modal that calls it.
 * What is pinned here is the contract with the view, because that is where the
 * two halves can disagree in ways nothing else would catch. `kind: 1` instead of
 * `2` builds a *private* room and 400s unless the list has exactly two entries,
 * so a group of three would fail with "Private chats must have exactly 2
 * participants." - a message about a chat kind the user never asked for. And
 * `RoomViewSet.create` appends the request user to `participants` itself, so the
 * client never needs its own id in the payload.
 */
import { mount } from "@vue/test-utils";
import NewGroupModal from "@/components/rooms/NewGroupModal.vue";
import actions from "@/store/actions.js";

const GENERIC = "An error has occurred. Please try again later.";

// What axios rejects with when nothing replied: `response` is undefined, and
// reading it throws a TypeError *inside* the catch - which is how the invite
// modal lost its message once already (`invitation_modal.spec.js`).
const noReplyFromServer = () =>
  Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

const statusFromServer = (code, data) =>
  Object.assign(new Error("failed"), { response: { status: code, data } });

const mockPost = jest.fn(() => Promise.resolve({ data: { id: 42 } }));

jest.mock("@/backend", () => ({
  post: (...args) => mockPost(...args),
  default: {}
}));

// `state.users` is keyed by id, so "the people you already chat with" is
// Object.values of it. I am 1; 2 and 3 are peers, and the ids deliberately do
// not run in name order.
function mountModal({ dispatch } = {}) {
  const spy = dispatch || jest.fn(() => Promise.resolve({ data: { id: 42 } }));
  // `mount`, not `shallowMount`: every control worth checking here is inside
  // CardModal's slot, and a stubbed child renders no slot at all. Which is why
  // `invitation_modal.spec.js` calls `addFriend()` on the vm - it has no
  // alternative. Here the checkboxes and the v-model between them and the
  // payload are the point, so the real thing is mounted.
  return mount(NewGroupModal, {
    mocks: {
      $store: {
        state: {
          users: {
            1: { id: 1, username: "alice" },
            2: { id: 2, username: "Carol" },
            3: { id: 3, username: "bob" }
          },
          userProfile: { id: 1, username: "alice" }
        },
        dispatch: spy
      }
    }
  });
}

// Opened and rendered, which is the only state in which any of this is on
// screen: CardModal is `v-if`'d on `showing`.
const open = async wrapper => {
  wrapper.vm.open();
  await wrapper.vm.$nextTick();
};

describe("the action", () => {
  const create = payload =>
    actions.createGroup({ dispatch: jest.fn() }, payload);

  beforeEach(() => mockPost.mockClear());

  it("posts a group to the room list", async () => {
    await create({ group_name: "Weekend", participants: [2, 3] });

    // The list endpoint, not an id: there is no room to address yet.
    expect(mockPost.mock.calls[0][0]).toBe("/api/v1/rooms/");
  });

  it("says the room is a group, and names it", async () => {
    // `kind` is the whole difference between this and a private chat, and it is
    // one integer in a payload nothing else reads. `RoomKind.GROUP` is 2.
    await create({ group_name: "Weekend", participants: [2, 3] });

    expect(mockPost.mock.calls[0][1]).toEqual({
      kind: 2,
      group_name: "Weekend",
      participants: [2, 3]
    });
  });

  it("sends exactly the people who were ticked", async () => {
    // Not the author: `RoomViewSet.create` appends the request user when they
    // are missing. Asserted because the payload above is the whole contract,
    // and a future "just be safe and include me" is one line that no test in
    // the repo would notice - the view dedupes it.
    await create({ group_name: "Weekend", participants: [2, 3] });

    expect(mockPost.mock.calls[0][1].participants).not.toContain(1);
  });

  it("rejects, so the modal can report why", async () => {
    // The action hands back the promise rather than swallowing it. Every reason
    // the server refuses a group is a 400 with a `detail`, and the modal can
    // only show what reaches it.
    mockPost.mockImplementationOnce(() =>
      Promise.reject(
        statusFromServer(400, { detail: "Group rooms must have a name." })
      )
    );

    await expect(create({ group_name: "", participants: [2] })).rejects.toBeDefined();
  });
});

describe("the picker", () => {
  it("offers your peers, in order, and not you", async () => {
    const wrapper = mountModal();
    await open(wrapper);

    // From `state.users` and nowhere else. There is no user-list endpoint to
    // offer anyone else from: `UsersAPIView` requires `?email=` and answers with
    // exactly one account, deliberately without `tagline`. So this list is the
    // only one the app can honestly show, and it is why the two names here are
    // peers who have exchanged a message with me.
    //
    // Sorted, because `state.users` is keyed by id in insertion order - arrival
    // order. A picker that reorders itself between openings is one people tick
    // the wrong row in. And alice is absent: my own messages carry my id, and
    // offering myself as someone to add is a row that cannot fail.
    expect(wrapper.vm.candidates.map(u => u.username)).toEqual(["bob", "Carol"]);
    expect(wrapper.text()).toContain("Carol");
  });

  it("says so when there is nobody to add", async () => {
    // The empty state is reachable: a signed-in user with no messages has an
    // empty `state.users`, and the picker would otherwise be an empty box with a
    // Create button and no explanation.
    const wrapper = mountModal();
    wrapper.vm.$store.state.users = {};
    await open(wrapper);

    expect(wrapper.findAll("input[type='checkbox']").length).toBe(0);
    expect(wrapper.text()).toMatch(/no messages|nobody/i);
  });

  it("every control in it is reachable and named", async () => {
    // Items 38 to 50 were six separate files about divs with click handlers.
    // This is a form, so the whole lesson checks in one place: a text input, a
    // checkbox per person and the buttons all have to be elements the keyboard
    // lands on, each with a name a screen reader can read.
    const wrapper = mountModal();
    await open(wrapper);

    const name = wrapper.find("input[type='text']");
    expect(name.element.tabIndex).toBe(0);
    expect(wrapper.find("label[for='group-name']").exists()).toBe(true);

    const boxes = wrapper.findAll("input[type='checkbox']");
    expect(boxes.length).toBe(2);
    boxes.wrappers.forEach(box => {
      expect(box.element.tabIndex).toBe(0);
      // Named by the label it sits inside - which is also what makes
      // `wrapper.text()` above the name a screen reader announces for it.
      expect(box.element.closest("label")).toBeTruthy();
    });

    const buttons = wrapper.findAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    buttons.wrappers.forEach(button => {
      expect(button.element.tabIndex).toBe(0);
      expect(button.text().trim()).not.toBe("");
    });
  });

  it("will not accept a name the server will refuse", async () => {
    // The attribute, not the enforcement, for the reason
    // `send_form_maxlength.spec.js` gives: jsdom does not reliably clamp a
    // programmatic `value =` to `maxlength`, so typing 256 characters in would
    // be testing jsdom rather than the component. What the browser honours is
    // the attribute being bound to the number the server enforces - and that
    // number is `test_the_group_name_cap_matches_the_model` on the Django side.
    const wrapper = mountModal();
    await open(wrapper);

    const limit = wrapper.find("input[type='text']").attributes("maxlength");

    expect(limit).toBeDefined();
    expect(Number(limit)).toBe(wrapper.vm.maxGroupName);
  });

  it("a name at the limit is still sendable", async () => {
    // The control on the test above. If `maxGroupName` were off by one in the
    // strict direction, the last name the server would have accepted would be
    // untypable and nothing else would say so - and "the input has a cap"
    // would still pass. This one must survive the cap being too generous.
    const dispatch = jest.fn(() => Promise.resolve({ data: {} }));
    const wrapper = mountModal({ dispatch });
    await open(wrapper);
    const atLimit = "x".repeat(wrapper.vm.maxGroupName);
    wrapper.vm.groupName = atLimit;

    await wrapper.vm.create();

    expect(dispatch).toHaveBeenCalledWith(
      "createGroup",
      expect.objectContaining({ group_name: atLimit })
    );
  });
});

describe("creating", () => {
  it("sends the name typed and the people ticked", async () => {
    // Driven through the DOM, not by assigning `wrapper.vm.selected`: the
    // `:value`/`v-model` pairing between each checkbox and the payload is the
    // part that can be wrong while every field on the vm looks correct.
    const dispatch = jest.fn(() => Promise.resolve({ data: {} }));
    const wrapper = mountModal({ dispatch });
    await open(wrapper);

    await wrapper.find("input[type='text']").setValue("Weekend");
    const boxes = wrapper.findAll("input[type='checkbox']");
    await boxes.at(0).setChecked(true);
    await boxes.at(1).setChecked(true);

    await wrapper.vm.create();

    expect(dispatch).toHaveBeenCalledWith("createGroup", {
      group_name: "Weekend",
      participants: expect.arrayContaining([2, 3])
    });
    expect(dispatch.mock.calls[0][1].participants.length).toBe(2);
  });

  it("closes on success, and empties itself", async () => {
    // `open()` and a successful create are the only two things that reset the
    // form, for the reason `InvitationModal` gives: `Home.vue` mounts this for
    // the whole session, so a name left in the field is the next group's
    // pre-filled value.
    const wrapper = mountModal();
    await open(wrapper);
    wrapper.vm.groupName = "Weekend";
    wrapper.vm.selected = [2];

    await wrapper.vm.create();

    expect(wrapper.vm.showModal).toBe(false);
    expect(wrapper.vm.groupName).toBe("");
    expect(wrapper.vm.selected).toEqual([]);
  });

  it("keeps what was typed when the server refuses", async () => {
    // Failure is the only outcome where the inputs are worth anything, and the
    // name is the one field with no way to recover it. Closing here is what
    // `ContactProfile.deleteChat` was fixed for.
    const wrapper = mountModal({
      dispatch: jest.fn(() =>
        Promise.reject(
          statusFromServer(400, { detail: "There must be at least one another participant." })
        )
      )
    });
    await open(wrapper);
    wrapper.vm.groupName = "Weekend";
    wrapper.vm.selected = [];

    await wrapper.vm.create();

    expect(wrapper.vm.showModal).toBe(true);
    expect(wrapper.vm.groupName).toBe("Weekend");
    expect(wrapper.vm.selected).toEqual([]);
  });

  it("says what the server said, not a guess", async () => {
    // `RoomViewSet.create` answers 400 for an unnamed group and for a group with
    // nobody else in it, and a 256-character name comes back as a field-errors
    // dict rather than `detail`. Reading the body is the only way to tell them
    // apart.
    const wrapper = mountModal({
      dispatch: jest.fn(() =>
        Promise.reject(
          statusFromServer(400, { detail: "Group rooms must have a name." })
        )
      )
    });
    await open(wrapper);

    await wrapper.vm.create();

    expect(wrapper.vm.error).toBe("Group rooms must have a name.");
  });

  it("falls back when the server sends no reason", async () => {
    // Same guard as the invite modal's, for the same reason: a 500 or a proxy's
    // HTML answer carries no `detail`, and showing nothing reads as "it worked".
    const wrapper = mountModal({
      dispatch: jest.fn(() => Promise.reject(statusFromServer(500)))
    });
    await open(wrapper);

    await wrapper.vm.create();

    expect(wrapper.vm.error).toBe(GENERIC);
  });

  it("an unreachable server still says something went wrong", async () => {
    // axios only sets `response` when the server actually replied. Reading it
    // unconditionally throws inside the catch, the method rejects, and the modal
    // shows nothing at all.
    const wrapper = mountModal({
      dispatch: jest.fn(() => Promise.reject(noReplyFromServer()))
    });
    await open(wrapper);

    await expect(wrapper.vm.create()).resolves.toBeUndefined();

    expect(wrapper.vm.error).toBe(GENERIC);
    expect(wrapper.vm.showModal).toBe(true);
  });

  it("clears the last message before the request goes out", async () => {
    // Deliberately not "the message is replaced": it is, by the catch, so a
    // test reading the value afterwards passes whether or not it was cleared
    // first. The first version of this test did exactly that, and it passed the
    // mutation it existed to catch.
    //
    // The window that matters is between pressing Create and the answer
    // arriving: a stale message sits under the inputs describing a group that
    // no longer exists, and reads as the answer to the Create just pressed.
    // `error` is otherwise only ever written inside a catch. The dispatch below
    // does not settle until released, so nothing can have overwritten it yet.
    let release;
    const dispatch = jest.fn(() => new Promise(resolve => (release = resolve)));
    const wrapper = mountModal({ dispatch });
    await open(wrapper);
    wrapper.vm.error = "There must be at least one another participant.";

    const pending = wrapper.vm.create();

    expect(wrapper.vm.error).toBe("");

    release({ data: {} });
    await pending;
  });
});

describe("the trigger in the room list", () => {
  it("is a button that asks for the modal", async () => {
    // Mounted with the same stubs the other specs use, because this is the only
    // test that looks at `UsersSection`, and what it has to answer is "is the
    // entry point reachable and named" - the item 38 question, for the control
    // that opens the feature.
    const UsersSection = require("@/components/users/UsersSection.vue").default;
    const wrapper = mount(UsersSection, {
      stubs: { search: true, Menu: true, "invite-friend": true },
      mocks: {
        $store: {
          state: {
            rooms: {},
            selectedRoom: null,
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

    const trigger = wrapper.find(".new-group-trigger");
    expect(trigger.exists()).toBe(true);
    expect(trigger.element.tagName).toBe("BUTTON");
    expect(trigger.element.tabIndex).toBe(0);
    // Named by its own text, so no aria-label to go stale against it.
    expect(trigger.text().trim()).toBe("New group");

    await trigger.trigger("click");

    expect(wrapper.emitted("group-action")).toBeTruthy();
  });
});