/* eslint-env jest */
/**
 * The fifteen actions no test has ever run.
 *
 * Measured, not guessed. A coverage run puts `actions.js` at 34.8% lines (73
 * missed) with every other file under `src/` at 100%, and reading
 * `coverage-final.json`'s `fnMap` names which fifteen:
 *
 *     markMessageAsRead  fetchUnreadMessages  postWriting  markRoomAsRead
 *     fetchSentInvitations  addFriend  cancelFriendRequest
 *     fetchReceivedInvitations  rejectFriendRequest  acceptFriendRequest
 *     deleteRoom  fetchUserProfile  patchUserProfile  fetchRoomActivity
 *     createGroup
 *
 * Eight are "covered" by tests that mock `$store.dispatch` -- those pin *that
 * an action was requested*, and the action itself never runs, so its URL, its
 * method and its commit are unpinned. `invitations_refusal.spec.js` is the
 * clearest case: "all three actions report a refusal" is about the component's
 * `.catch`, and accept/reject/cancel have never issued a request.
 *
 * The negative came first, and it is why this file is a contract rather than a
 * hunt. All fifteen URLs and HTTP methods were compared against
 * `chat/api/urls.py`, `friends/api/urls.py` and `users/api/urls.py` and every
 * one matches -- including `messages/unread`, which is one path serving both a
 * GET (`fetchUnreadMessages`) and a POST (`markMessageAsRead`) because
 * `UnreadMessagesAPIView` implements both. So no defect is filed here. What is
 * pinned is that a hand-edited URL is a red test rather than a 404 in a browser
 * console nobody is watching.
 *
 * One is pinned as committing *nothing*, and that is the assertion most likely
 * to be argued with: `deleteRoom` clears nothing locally, because the sidebar
 * row disappears on the `room_delete` push that `RoomDeleteAPIView.post` sends
 * before deleting the room, and `App.vue:50-55` answers with `REMOVE_ROOM`. A
 * local commit here would look like a fix, and would remove the row for the
 * deleter while leaving the peer with a room that 404s.
 *
 * The `createGroup` case below argues the same way about the `update_rooms`
 * push. That argument had a hole in it for one item: every word of it was
 * checked except the hop it rests on, and item 81's sweep found `App.vue:48-49`
 * had no test at all -- deleting it left a group you created invisible to
 * everyone else with no error anywhere. `push_handlers.spec.js` pins it now; read
 * that file as part of this one rather than as an extra.
 */
import actions from "@/store/actions.js";

const mockGet = jest.fn(() =>
  Promise.resolve({ data: { messages: [], users: [], room: {} } })
);
const mockPost = jest.fn(() => Promise.resolve({ data: [] }));
const mockPatch = jest.fn(() => Promise.resolve({ data: {} }));

jest.mock("@/backend", () => ({
  get: (...args) => mockGet(...args),
  post: (...args) => mockPost(...args),
  patch: (...args) => mockPatch(...args),
  default: {}
}));

const commits = jest.fn();

beforeEach(() => {
  mockGet.mockClear();
  mockPost.mockClear();
  mockPatch.mockClear();
  commits.mockClear();
});

const got = () => mockGet.mock.calls[0][0];
const posted = () => mockPost.mock.calls[0][0];
const postedBody = () => mockPost.mock.calls[0][1];
const patchedBody = () => mockPatch.mock.calls[0][1];

// Every action here commits at most once, so `commits.mock.calls[0]` is the
// whole story and reading it directly keeps each test to three lines.
const run = name => payload => actions[name]({ commit: commits }, payload);

test("unread messages come from the unread endpoint, not from a room", async () => {
  await run("fetchUnreadMessages")();

  expect(got()).toBe("/api/v1/messages/unread");
  expect(commits.mock.calls[0]).toEqual(["ADD_UNREAD_MESSAGES", []]);
});

test("a read receipt posts to that same endpoint with the message as a query", async () => {
  // One path, two methods. The read receipt carries `message_id` in the query
  // string, which is the only thing telling it apart from the GET above.
  await run("markMessageAsRead")(42);

  expect(posted()).toBe("/api/v1/messages/unread?message_id=42");
  expect(commits.mock.calls[0]).toEqual(["REMOVE_MESSAGE_FROM_UNREAD", 42]);
});

test("opening a room marks it read and clears only that room's badge", async () => {
  await run("markRoomAsRead")(7);

  expect(posted()).toBe("/api/v1/rooms/7/read");
  expect(commits.mock.calls[0][0]).toBe("REMOVE_ROOM_MESSAGES_FROM_UNREAD");
  expect(commits.mock.calls[0][1]).toBe(7);
});

test("typing posts to the room and commits nothing", async () => {
  await run("postWriting")(7);

  expect(posted()).toBe("/api/v1/rooms/7/writing");
  // The peer's indicator comes off the `writing` push, not off local state.
  expect(commits).not.toHaveBeenCalled();
});

test("deleting a chat posts to the room and commits nothing locally", async () => {
  // See the header: the row is removed by the `room_delete` push.
  await run("deleteRoom")(7);

  expect(posted()).toBe("/api/v1/rooms/7/delete");
  expect(commits).not.toHaveBeenCalled();
});

test("the two invitation tabs are two different endpoints", async () => {
  await run("fetchSentInvitations")();

  expect(got()).toBe("/api/v1/friends/requests/sent");
  expect(commits.mock.calls[0][0]).toBe("SET_SENT_INVITATIONS");

  commits.mockClear();
  mockGet.mockClear();
  await run("fetchReceivedInvitations")();

  expect(got()).toBe("/api/v1/friends/requests/received");
  expect(commits.mock.calls[0][0]).toBe("SET_RECEIVED_INVITATIONS");
});

test("the three things you can do to an invitation are three different posts", async () => {
  // Accept, reject and cancel all carry the request id in the path and all
  // replace a list. A reversion that swapped two of the three verbs builds
  // three plausible URLs and is invisible until somebody cancels an invitation
  // and cancels it again.
  const verbs = [
    ["acceptFriendRequest", "accept", "SET_RECEIVED_INVITATIONS"],
    ["rejectFriendRequest", "reject", "SET_RECEIVED_INVITATIONS"],
    ["cancelFriendRequest", "cancel", "SET_SENT_INVITATIONS"]
  ];

  for (const [action, verb, commitName] of verbs) {
    mockPost.mockClear();
    commits.mockClear();
    await run(action)(12);

    expect(posted()).toBe(`/api/v1/friends/requests/${verb}/12`);
    expect(commits.mock.calls[0][0]).toBe(commitName);
  }
});

test("adding a friend posts the user id and refreshes the sent tab", async () => {
  await run("addFriend")(9);

  expect(posted()).toBe("/api/v1/friends/add/9");
  expect(commits.mock.calls[0][0]).toBe("SET_SENT_INVITATIONS");
});

test("your own profile is read with GET and written with PATCH", async () => {
  mockGet.mockImplementationOnce(() =>
    Promise.resolve({ data: { id: 1, username: "alice" } })
  );
  await run("fetchUserProfile")();

  expect(got()).toBe("/api/v1/me");
  // The whole body, not a field: `SET_USER_PROFILE` replaces the object
  // outright, so which fields the server sends is the whole contract.
  expect(commits.mock.calls[0]).toEqual([
    "SET_USER_PROFILE",
    { id: 1, username: "alice" }
  ]);

  commits.mockClear();
  mockPatch.mockImplementationOnce(() =>
    Promise.resolve({ data: { username: "alice" } })
  );
  await run("patchUserProfile")({ tagline: "hi" });

  // PATCH, not POST. `CurrentUserAPIView` is a `RetrieveUpdateAPIView` and
  // answers both -- but a POST there is a 405, so this is the difference
  // between a saved profile and a console error.
  expect(mockPatch.mock.calls[0][0]).toBe("/api/v1/me");
  expect(patchedBody()).toEqual({ tagline: "hi" });
  expect(commits.mock.calls[0]).toEqual([
    "SET_USER_PROFILE",
    { username: "alice" }
  ]);
});

test("the activity chart is fetched per room", async () => {
  await run("fetchRoomActivity")(7);

  expect(got()).toBe("/api/v1/rooms/7/activity");
  expect(commits.mock.calls[0][0]).toBe("SET_ROOM_ACTIVITY");
});

test("a group is created with kind 2, its name and its participants", async () => {
  // `kind` is load-bearing and is not implied by `group_name`: `kind: 1` is a
  // private room, which `RoomViewSet.create` refuses unless the list is exactly
  // two. The author is added server-side, so the client sends the people it
  // chose.
  await run("createGroup")({ group_name: "Trip", participants: [3, 4] });

  expect(posted()).toBe("/api/v1/rooms/");
  expect(postedBody()).toEqual({
    kind: 2,
    group_name: "Trip",
    participants: [3, 4]
  });
  // The group reaches every participant's sidebar off the `update_rooms` push
  // the view sends, which `App.vue:48-49` answers with `fetchRooms`.
  expect(commits).not.toHaveBeenCalled();
});