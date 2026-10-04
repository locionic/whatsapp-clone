/* eslint-env jest */
/**
 * A component that throws while rendering must fail the test that rendered it.
 *
 * This exists because one did not. `MessagesSection.vue` dereferenced
 * `rooms[selectedRoom].group_name` with `selectedRoom` at its starting value of
 * `null`, so every desktop-width load rendered a pane containing only the outer
 * `<div class="relative">` - and `room_paging_race.spec.js`, which had been
 * throwing the same way on every run, reported PASS throughout. Item 61 fixed
 * the component; this makes the class of failure visible next time.
 *
 * Why the standard mechanism misses it. `@vue/test-utils` already fails a test
 * whose component throws: its handler marks `vm._error` and rethrows, and
 * `throwIfInstancesThrew` turns that into a failure at the next checkpoint. Its
 * own source says why that is not enough - "Vue swallows errors thrown by
 * instances, even if the global error handler throws". A render error raised by
 * a *re-render* lands inside `flushSchedulerQueue`, a microtask, where the
 * rethrow has nobody to catch it: it leaves as an unhandled rejection, jest
 * prints it as console noise between tests, and no test is attributed. The
 * checkpoints VTU relies on are all before that.
 *
 * Why not fix it by installing a `Vue.config.errorHandler` here, which sounds
 * like the obvious thing. `addGlobalErrorHandler` refuses to install its own
 * handler when a global one already exists - it warns and returns - so claiming
 * that field would quietly switch off the `_error` mechanism above and trade a
 * hole for a different, larger one. Observing what Vue prints costs no such
 * trade: the same `logError` call reaches `console.error` either way.
 *
 * Scoped to render errors on purpose. The suite has eight deliberate
 * created-hook failures, all of them in `websocket_reconnect.spec.js`, which
 * injects `Promise.reject(new Error("offline"))` and asserts the failure *is*
 * handled - the other six load fetches still issued, a failed unread fetch still
 * fetching messages, no rejection escaping a push handler. Those are the
 * *expected* outcome of the tests that produce them. A render error is never
 * expected: a render is supposed to produce a subtree, and a throw means it
 * produced nothing.
 */

const REAL_CONSOLE_ERROR = console.error;
const RENDER_MARKER = "Error in render";

let renderErrors = [];

beforeEach(() => {
  renderErrors = [];
  console.error = (...args) => {
    const line = args.map(String).join(" ");
    if (line.includes(RENDER_MARKER)) renderErrors.push(line);
    REAL_CONSOLE_ERROR(...args); // keep the original output, it is evidence too
  };
});

afterEach(() => {
  console.error = REAL_CONSOLE_ERROR;
  if (renderErrors.length === 0) return;
  throw new Error(
    "a component threw while rendering, so the DOM this test went on to " +
      "assert against was never built - and the test still passed:\n  " +
      renderErrors.join("\n  ")
  );
});