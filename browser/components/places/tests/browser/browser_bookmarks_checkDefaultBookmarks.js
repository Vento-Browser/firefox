/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// check that the correct default bookmarks are imported with each build type
// browser/base/content/default-bookmarks.html

const PREF_RESTORE_DEFAULT_BOOKMARKS =
  "browser.bookmarks.restore_default_bookmarks";

const TOPIC_BROWSERGLUE_TEST = "browser-glue-test";
const TOPICDATA_FORCE_PLACES_INIT = "test-force-places-init";

async function fetchMenuTree() {
  function nodeToInfo({ uri, children }) {
    return {
      ...(uri ? { uri } : {}),
      ...(children ? { children: children.map(nodeToInfo) } : {}),
    };
  }
  return nodeToInfo(
    await PlacesUtils.promiseBookmarksTree(PlacesUtils.bookmarks.menuGuid)
  );
}

async function simulatePlacesInit() {
  info("Simulate Places init");
  let { PlacesBrowserStartup } = ChromeUtils.importESModule(
    "moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs"
  );
  PlacesBrowserStartup._placesInitialized = false;
  PlacesBrowserStartup.initPlaces();
  return TestUtils.topicObserved("places-browser-init-complete");
}

add_task(async function checkDefaultBookmarks() {
  await PlacesUtils.bookmarks.eraseEverything();

  Services.prefs.setBoolPref(PREF_RESTORE_DEFAULT_BOOKMARKS, true);

  await simulatePlacesInit();

  Assert.ok(!Services.prefs.setBoolPref(PREF_RESTORE_DEFAULT_BOOKMARKS, false));

  // Vento ships a single de-branded default bookmark on every channel.
  Assert.deepEqual(await fetchMenuTree(), {
    children: [
      {
        uri: "https://vento-browser.com/",
      },
    ],
  });
});
