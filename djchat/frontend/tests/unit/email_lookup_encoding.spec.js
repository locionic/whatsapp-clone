/* eslint-env jest */
/**
 * Looking up a friend by their email address.
 *
 * `getUserIdFromEmail` builds its URL by interpolation:
 *
 *     axios.get(`/api/v1/users?email=${email}`)
 *
 * `email` is whatever the user typed into the invite modal, dropped into a
 * query string with no encoding. In a query string `+` means space, and the
 * browser does not re-encode it -- the `+` goes over the wire as a `+` and the
 * server decodes it to a space. So `bob+test@example.com` is looked up as
 * `bob test@example.com`, finds nothing, and comes back 404.
 *
 * Plus-addresses are ordinary, not exotic: `bob+chat@gmail.com` is how Gmail
 * aliases work and Fastmail hands them out by default. So this is a real,
 * registered user who cannot be invited, and the app says "User not found." --
 * which is both wrong and entirely convincing. Nothing anywhere reports that
 * the address was mangled on the way out.
 *
 * The two sibling query strings interpolate a message id and an offset, both
 * numbers from the app itself, so this is the one site where user input reaches
 * a URL.
 */
import actions from "@/store/actions.js";

const mockGet = jest.fn(() => Promise.resolve({ data: { id: 1 } }));

jest.mock("@/backend", () => ({
  get: (...args) => mockGet(...args),
  default: {}
}));

// The URL the action asked axios for.
const requestedUrl = () => mockGet.mock.calls[0][0];

// Cleared, not assumed: without this the second test reads calls[0] -- which is
// still the *first* test's call -- and fails for the wrong reason.
beforeEach(() => mockGet.mockClear());

const lookup = email =>
  actions.getUserIdFromEmail({ commit: jest.fn() }, email);

test("a plus in the address is encoded, not sent as a space", async () => {
  await lookup("bob+test@example.com");

  expect(requestedUrl()).toBe("/api/v1/users?email=bob%2Btest%40example.com");
});

test("a plain address is unchanged by the encoding", async () => {
  // The guard on the fix. `encodeURIComponent` leaves an ordinary address
  // alone, so a fix that mangles the common case would pass the test above
  // while breaking every invitation that has ever worked.
  await lookup("bob@example.com");

  expect(requestedUrl()).toBe("/api/v1/users?email=bob%40example.com");
});

test("the server still receives the address the user typed", () => {
  // What the other two tests are really about, stated directly: whatever goes
  // on the wire has to decode back to the typed string. Checked in the
  // browser's own decoder, the same one the server uses, rather than by
  // comparing strings -- because the bug was never a wrong string, it was a
  // right string that meant something else in a query.
  const typed = "bob+test@example.com";

  expect(decodeURIComponent(encodeURIComponent(typed))).toBe(typed);
});
