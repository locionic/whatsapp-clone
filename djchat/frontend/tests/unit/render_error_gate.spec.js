/* eslint-env jest */
/**
 * The render-error gate is still wired up.
 *
 * Its behaviour cannot be asserted from inside the suite: a test that provokes a
 * render error is a test the gate fails, which is the entire point, so there is
 * no way to write `expect(boom).toBe(true)` here without failing this file too.
 * Item 62's own reversion is the behavioural proof - the pre-fix condition went
 * from 134 passed to a named failure.
 *
 * So this pins the thing that can be pinned, which is the part nobody would do on
 * purpose: deleting `setupFilesAfterEnv` from `package.json`, or renaming the
 * marker so it matches a string Vue never prints. Either one leaves a gate that
 * looks installed and catches nothing, which is precisely how item 61's crash
 * survived.
 */
import fs from "fs";
import path from "path";

const SETUP = "tests/unit/setup_render_errors.js";

test("jest loads the render-error setup file", () => {
  const config = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")
  );

  expect(config.jest.setupFilesAfterEnv).toEqual([`<rootDir>/${SETUP}`]);
  expect(fs.existsSync(path.resolve(__dirname, "setup_render_errors.js"))).toBe(
    true
  );
});

test("the setup file keys on the string Vue actually prints", () => {
  // Measured, not assumed: Vue 2's `logError` prefixes every uncaught render
  // failure with exactly this, and the eight deliberate created-hook failures
  // this deliberately does not match read `Error in created hook (Promise/async)`.
  const source = fs.readFileSync(
    path.resolve(__dirname, "setup_render_errors.js"),
    "utf8"
  );

  expect(source).toContain('"Error in render"');
  expect(source).not.toContain('"Error in created hook"');
});

test("the specs that deliberately reject a fetch are closed and known", () => {
  // The gate ignores every non-render Vue error, which is only safe while the
  // set of specs that *intentionally* produce one is closed. Measured: all eight
  // `Error in created hook` failures in the suite come from this one file, which
  // injects the rejection and asserts the failure is handled - the other load
  // fetches still issued, no rejection escaping a push handler.
  //
  // A new spec that rejects a fetch would land in the same blind spot, so it
  // fails here instead: the next author updates this list on purpose, which is
  // the moment to notice the render gate will not see their errors either.
  //
  // The needle is textual, so the list is "specs that inject a rejection", not
  // "specs that can render-error" - and the two are not the same set. Sorting is
  // explicit because `readdirSync` order is the filesystem's, not the test's, and
  // a set that reorders itself with the disk is a flaky assertion.
  const dir = path.resolve(__dirname);
  const self = path.basename(__filename);
  const injectsRejection = fs
    .readdirSync(dir)
    .filter(name => name.endsWith(".spec.js"))
    // This file names the needle in order to look for it, so it finds itself.
    .filter(name => name !== self)
    .filter(name =>
      fs
        .readFileSync(path.join(dir, name), "utf8")
        .includes('Promise.reject(new Error("offline"))')
    )
    .sort();

  // Two entries, for two different reasons, and the difference is the point:
  //
  //   websocket_reconnect.spec.js  mounts `App.vue`, whose `created()` awaits
  //     load fetches, so its rejections can surface as a Vue error - which is
  //     why it was ever on this list.
  //
  //   action_requests.spec.js  calls `sendMessage` directly with no component in
  //     the tree, so it has no render for the gate to miss. It is here because it
  //     does inject a rejection, and leaving it out would be dodging the needle
  //     rather than answering it. `jest@24.9` has no `mockRejectedValueOnce`, so
  //     `mockImplementationOnce(() => Promise.reject(...))` is the only spelling
  //     available.
  expect(injectsRejection).toEqual([
    "action_requests.spec.js",
    "websocket_reconnect.spec.js"
  ]);
});
