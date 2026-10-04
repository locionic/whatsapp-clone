/* eslint-env jest */
/**
 * Five focusable elements in this app make focus invisible.
 *
 * Tailwind's preflight gives every button and input a focus ring.
 * `focus:outline-none` takes it away, and on five elements nothing puts anything
 * back:
 *
 *     SendForm.vue:6            the message box
 *     UserProfile.vue:61        "Add some info."
 *     InviteButton.vue:7        "Invite a Friend"
 *     Invitations.vue:10, :30   the Sent and Received tabs
 *
 * `Search.vue:5` and `InvitationModal.vue:15` remove the outline *and* replace it,
 * with `focus:shadow-outline` -- the codebase's own indicator, already in the
 * built CSS. So the convention exists here; these five skip the second half.
 *
 * Unlike item 38 this is not reachability: every one of these five is already a
 * real `<button>` or `<input>` and already takes focus. The defect is that focus
 * lands somewhere you cannot see.
 *
 * This reads every `.vue` under `src/`, not those five files. Naming them here
 * records what was found; the scan is what stops a sixth.
 */
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../../src");
const DIST_CSS = path.resolve(__dirname, "../../../static/dist/bundle.css");

function vueFiles(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((all, entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return all.concat(vueFiles(full));
    return entry.name.endsWith(".vue") ? all.concat(full) : all;
  }, []);
}

// `[^"]*` rather than `.`, because four of these class attributes wrap onto the
// next line. `InviteButton.vue:7` was missed by exactly that mistake once already,
// when a line-based grep reported four offenders instead of five.
// `:class` is deliberately not matched: it carries conditional state, not
// utilities, and scanning it would only produce false positives.
const CLASS_ATTR = /class="([^"]*)"/g;

const REMOVES = "focus:outline-none";
const REPLACES = "focus:shadow-outline";

function elementsLeftInTheDark() {
  const offenders = [];
  for (const file of vueFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, classes] of source.matchAll(CLASS_ATTR)) {
      if (classes.includes(REMOVES) && !classes.includes(REPLACES)) {
        offenders.push(path.relative(SRC, file));
      }
    }
  }
  return offenders;
}

test("nothing removes the focus ring without putting another one there", () => {
  expect(elementsLeftInTheDark()).toEqual([]);
});

// The artifact half of the trap item 38 found: a class added to the source is
// worth nothing until the committed bundle carries it. `focus:shadow-outline` is
// the fix for all five above, so if this build did not emit it, every one of
// those five would be edited into a class that does nothing.
test("the indicator this relies on is in the build the app loads", () => {
  const css = fs.readFileSync(DIST_CSS, "utf8");

  expect(css).toContain(".focus\\:shadow-outline:focus");
  // And that it is an actual ring, not an empty rule.
  expect(css).toMatch(/\.focus\\:shadow-outline:focus\{[^}]*box-shadow:[^}]*\}/);
});