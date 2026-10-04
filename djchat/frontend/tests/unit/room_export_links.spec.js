/* eslint-env jest */
/**
 * The export endpoint had no UI at all.
 *
 * `GET /api/v1/rooms/<id>/export?as=json|csv` is built, routed, and covered by
 * eight tests on the Django side - membership, CSV quoting, empty rooms, and
 * the rule that a download must not consume pending delivery state. Grepping
 * `frontend/src` and `frontend/tests` for `/export` returned nothing. A
 * finished, tested feature that no user could reach, in any build, ever.
 *
 * The client half has to stay JavaScript-free, and that is not a style
 * preference. The download is decided by the server's Content-Disposition
 * header, so the whole thing is two bare <a href> tags: no axios action, no
 * blob, no object URL to revoke, no state, no store mutation. The tests below
 * assert on the href attributes, which is where that decision shows up.
 */
import { shallowMount } from "@vue/test-utils";
import ContactProfile from "@/components/profiles/ContactProfile.vue";

function mountProfile(state = {}) {
  return shallowMount(ContactProfile, {
    propsData: { rightSidenav: true },
    mocks: {
      $store: {
        state: {
          width: 1200,
          selectedRoom: 7,
          rooms: {
            7: { id: 7, group_profile: { username: "Bob", tagline: "" } },
            9: { id: 9, group_profile: { username: "Carol", tagline: "" } }
          },
          roomActivity: null,
          ...state
        },
        dispatch: () => Promise.resolve(),
        commit: jest.fn()
      }
    }
  });
}

function exportLinks(wrapper) {
  return wrapper.findAll("a[href*='/export']").wrappers;
}

function exportHrefs(wrapper) {
  return exportLinks(wrapper).map(w => w.attributes("href"));
}

test("both formats are offered", () => {
  // One is not two. Shipping CSV alone would pass any test that only asks
  // "is there an export link", and would leave the format the endpoint
  // defaults to - and the one carrying the room's participants - unreachable.
  const hrefs = exportHrefs(mountProfile());

  expect(hrefs).toContain("/api/v1/rooms/7/export?as=csv");
  expect(hrefs).toContain("/api/v1/rooms/7/export?as=json");
});

test("the links point at the chat that is open", () => {
  // The panel is a slide-over, not a navigation: it rebinds in place while it
  // stays open, so "the room" here is whichever room is selected right now.
  // An href built from a room captured at mount would download Bob's chat while
  // the panel is showing Carol's, and nothing would say which one you got.
  expect(exportHrefs(mountProfile({ selectedRoom: 9 }))).toEqual([
    "/api/v1/rooms/9/export?as=csv",
    "/api/v1/rooms/9/export?as=json"
  ]);
});

test("the links are plain anchors, so the server is what downloads the file", () => {
  // If these ever grow a @click handler, something client-side has taken over
  // responsibility for the file, and the guarantee that `?as=json` and
  // `?as=csv` behave identically becomes the frontend's to keep.
  const links = exportLinks(mountProfile());

  expect(links.length).toBe(2);
  links.forEach(link => expect(link.attributes("href")).toBeTruthy());
});

test("the panel scrolls, so the export did not push Delete chat out of reach", () => {
  // `.user-details` and `.user-profile-sidenav` are marker class names with no
  // rule anywhere in src/ - the panel is `height: 100%` and did not scroll.
  // Adding a block to a panel that already overflows on a short viewport would
  // make the delete button unreachable, which is a worse regression than
  // having no export at all.
  const sidepanel = mountProfile().find(".user-profile-sidenav");

  expect(sidepanel.classes()).toContain("overflow-y-auto");
});

test("the panel still offers the delete it always did", () => {
  // The control for the test above: the scroll class is additive, and must not
  // have displaced the button whose failure message was item 19's and item
  // 25's whole subject.
  expect(mountProfile().text()).toContain("Delete chat");
});