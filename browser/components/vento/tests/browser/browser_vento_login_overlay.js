/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The login gate must not be a separate app-modal window that can float above
 * other applications or be closed to reveal the tabs behind it. Instead, every
 * browser window paints a full-window login overlay (framing the login gate
 * page) while VentoAuth reports login as required, and removes it once the user
 * completes login.
 */

"use strict";

const { VentoAuth } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoAuth.sys.mjs"
);

function loginOverlay() {
  return document.getElementById("vento-login-overlay");
}

// Startup may already have flagged login as required (BrowserGlue calls
// requireLogin unless VENTO_TEST_NO_LOGIN_GATE is set), so each task starts
// from a known logged-in baseline rather than assuming no overlay is present.
async function resetToLoggedIn() {
  VentoAuth.notifyLoggedIn();
  await TestUtils.waitForCondition(
    () => !loginOverlay(),
    "no login overlay in the logged-in baseline"
  );
}

add_task(async function test_login_overlay_covers_and_clears() {
  registerCleanupFunction(() => VentoAuth.notifyLoggedIn());
  await resetToLoggedIn();

  Assert.equal(loginOverlay(), null, "no overlay before login is required");
  Assert.equal(
    document.documentElement.hasAttribute("vento-login-required"),
    false,
    "no login-required attribute before login is required"
  );

  const loginPromise = VentoAuth.requireLogin();

  await TestUtils.waitForCondition(
    () => !!loginOverlay(),
    "the login overlay must appear once login is required"
  );

  const overlay = loginOverlay();
  const frame = overlay.querySelector(".vento-login-frame");
  Assert.ok(frame, "the overlay frames the login gate page");
  Assert.equal(
    frame.getAttribute("src"),
    "chrome://browser/content/loginGate.html",
    "the frame loads the login gate"
  );
  Assert.equal(
    document.documentElement.getAttribute("vento-login-required"),
    "true",
    "browser keyboard shortcuts are blocked while login is required"
  );

  // Completing login (as the gate page does via VentoAuth.notifyLoggedIn)
  // resolves the promise and tears the overlay down in every window.
  let resolved = false;
  loginPromise.then(() => {
    resolved = true;
  });
  VentoAuth.notifyLoggedIn();

  await TestUtils.waitForCondition(
    () => !loginOverlay(),
    "the login overlay must be gone after login completes"
  );
  await loginPromise;
  Assert.ok(resolved, "requireLogin() resolves once login completes");
  Assert.equal(
    document.documentElement.hasAttribute("vento-login-required"),
    false,
    "the login-required attribute is cleared after login completes"
  );
});

add_task(async function test_concurrent_requests_share_one_overlay() {
  registerCleanupFunction(() => VentoAuth.notifyLoggedIn());
  await resetToLoggedIn();

  const first = VentoAuth.requireLogin();
  const second = VentoAuth.promptReauth();

  await TestUtils.waitForCondition(
    () => !!loginOverlay(),
    "the login overlay appears for the first request"
  );
  Assert.equal(
    document.querySelectorAll("#vento-login-overlay").length,
    1,
    "concurrent requests share a single overlay"
  );

  VentoAuth.notifyLoggedIn();

  const results = await Promise.all([first, second]);
  Assert.deepEqual(
    results,
    [true, true],
    "every pending request resolves once login completes"
  );
  await TestUtils.waitForCondition(
    () => !loginOverlay(),
    "the shared overlay is removed once login completes"
  );
});
