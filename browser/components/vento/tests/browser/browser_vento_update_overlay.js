/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The forced-update gate must not be a separate app-modal window that can float
 * above other applications. Instead, every browser window paints a full-window
 * update overlay (framing the update gate page) while VentoWebSocket reports a
 * forced update as required, and removes it once the user chooses to download.
 */

"use strict";

const { VentoWebSocket } = ChromeUtils.importESModule(
  "resource:///modules/VentoWebSocket.sys.mjs"
);

function updateOverlay() {
  return document.getElementById("vento-update-overlay");
}

async function resetToUpToDate() {
  VentoWebSocket.dismissUpdate();
  await TestUtils.waitForCondition(
    () => !updateOverlay(),
    "no update overlay in the up-to-date baseline"
  );
}

add_task(async function test_update_overlay_covers_and_clears() {
  registerCleanupFunction(() => VentoWebSocket.dismissUpdate());
  await resetToUpToDate();

  Assert.equal(
    updateOverlay(),
    null,
    "no overlay before an update is required"
  );
  Assert.equal(
    document.documentElement.hasAttribute("vento-update-required"),
    false,
    "no update-required attribute before an update is required"
  );

  const params =
    "required=99.0&current=1.0&download=https%3A%2F%2Fexample.test";
  VentoWebSocket._requireUpdate(params);

  await TestUtils.waitForCondition(
    () => !!updateOverlay(),
    "the update overlay must appear once an update is required"
  );

  const overlay = updateOverlay();
  const frame = overlay.querySelector(".vento-update-frame");
  Assert.ok(frame, "the overlay frames the update gate page");
  Assert.equal(
    frame.getAttribute("src"),
    `chrome://browser/content/updateGate.html?${params}`,
    "the frame loads the update gate with the version params"
  );
  Assert.equal(
    document.documentElement.getAttribute("vento-update-required"),
    "true",
    "browser keyboard shortcuts are blocked while an update is required"
  );

  // Choosing to download (as the gate page does via dismissUpdate) tears the
  // overlay down in every window.
  VentoWebSocket.dismissUpdate();

  await TestUtils.waitForCondition(
    () => !updateOverlay(),
    "the update overlay must be gone after the user chooses to download"
  );
  Assert.equal(
    document.documentElement.hasAttribute("vento-update-required"),
    false,
    "the update-required attribute is cleared after dismissal"
  );
});
