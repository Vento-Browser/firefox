/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The lock must not leave tab contents reachable behind it. Instead of a
 * separate app-modal window that could be closed to reveal the tabs, every
 * browser window paints a full-window lock overlay while locked and removes it
 * only once the user authenticates.
 */

"use strict";

const { VentoLockService } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoLockService.sys.mjs"
);

function lockOverlay() {
  return document.getElementById("vento-lock-overlay");
}

function overlayShown() {
  const overlay = lockOverlay();
  return (
    document.documentElement.hasAttribute("vento-locked") &&
    !!overlay &&
    window.getComputedStyle(overlay).display !== "none"
  );
}

add_task(async function test_lock_overlay_covers_content() {
  // The real unlock path shows a native OS auth dialog, which cannot be mocked
  // on the release update channel. The overlay imports the same module
  // singleton, so stubbing requestUnlock covers the wiring.
  const origRequestUnlock = VentoLockService.requestUnlock;
  VentoLockService.requestUnlock = async () => true;
  registerCleanupFunction(() => {
    VentoLockService.requestUnlock = origRequestUnlock;
    VentoLockService.unlock();
  });

  Assert.equal(overlayShown(), false, "overlay is hidden before locking");

  VentoLockService.lock();
  Assert.equal(
    VentoLockService.locked,
    true,
    "service reports the browser as locked"
  );
  Assert.equal(
    overlayShown(),
    true,
    "the lock overlay must cover the window while locked"
  );

  // Focus must stay trapped inside the overlay: moving focus to the content
  // browser (or tabbing out of the unlock buttons) would let the keyboard reach
  // the tab hidden behind the overlay, defeating the lock.
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(
    () => lockOverlay().contains(document.activeElement),
    "focus is pulled back into the lock overlay"
  );
  Assert.ok(
    lockOverlay().contains(document.activeElement),
    "focus cannot leave the lock overlay while locked"
  );

  // Clicking Unlock authenticates (stubbed) and lifts the lock.
  lockOverlay().querySelector(".vento-lock-primary-btn").click();
  await TestUtils.waitForCondition(
    () => !VentoLockService.locked,
    "unlock completes"
  );

  Assert.equal(
    overlayShown(),
    false,
    "the lock overlay must be gone after unlocking"
  );
});
