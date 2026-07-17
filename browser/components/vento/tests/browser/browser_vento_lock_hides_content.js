/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The lock window must not leave tab contents visible behind it: while
 * lockGate.html is open every browser window is hidden at the widget level
 * (nsIBaseWindow.visibility = false) and restored after unlock.
 */

"use strict";

const { VentoLockService } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoLockService.sys.mjs"
);
const { VentoAuth } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoAuth.sys.mjs"
);
function contentObscured() {
  // Widget-level visibility does not reflect reliably in headless mode, so
  // the observable contract is the vento-obscured attribute plus the CSS
  // rule blanking the window body.
  return (
    document.documentElement.hasAttribute("vento-obscured") &&
    window.getComputedStyle(document.body).visibility === "hidden"
  );
}

add_task(async function test_helper_hides_and_restores() {
  let obscuredInside;
  const result = VentoAuth.withBrowserWindowsHidden(() => {
    obscuredInside = contentObscured();
    return "ret";
  });
  Assert.equal(result, "ret", "helper returns fn's value");
  Assert.equal(
    obscuredInside,
    true,
    "browser window contents must be hidden while fn runs"
  );
  Assert.equal(
    contentObscured(),
    false,
    "browser window contents must be restored after fn returns"
  );
});

add_task(async function test_lock_window_hides_browser() {
  // The real unlock path shows a native OS auth dialog, which cannot be
  // mocked on the release update channel. lockGate.js imports the same
  // module singleton, so stubbing requestUnlock covers the wiring.
  const origRequestUnlock = VentoLockService.requestUnlock;
  VentoLockService.requestUnlock = async () => true;
  registerCleanupFunction(() => {
    VentoLockService.requestUnlock = origRequestUnlock;
  });

  let obscuredWhileLocked = null;
  const gateClosed = new Promise(resolve => {
    const observer = subject => {
      const win = subject;
      win.addEventListener(
        "load",
        () => {
          if (!win.location.href.includes("lockGate.html")) {
            return;
          }
          Services.ww.unregisterNotification(observer);
          obscuredWhileLocked = contentObscured();
          win.addEventListener("unload", () => resolve(), { once: true });
          win.document.getElementById("unlock-btn").click();
        },
        { once: true }
      );
    };
    Services.ww.registerNotification(observer);
  });

  // lock() opens an app-modal window and spins a nested event loop; the
  // observer above unlocks it, letting lock() return.
  VentoLockService.lock();
  await gateClosed;

  Assert.equal(
    obscuredWhileLocked,
    true,
    "browser window contents must be hidden while the lock window is shown"
  );
  Assert.equal(
    contentObscured(),
    false,
    "browser window contents must be visible again after unlock"
  );
});
