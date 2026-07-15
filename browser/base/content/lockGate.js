/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { VentoLockService } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoLockService.sys.mjs"
);

let unlocked = false;

const unlockBtn = document.getElementById("unlock-btn");
const signoutBtn = document.getElementById("signout-btn");
const errorEl = document.getElementById("lock-error");

unlockBtn.addEventListener("click", async () => {
  errorEl.hidden = true;
  unlockBtn.disabled = true;
  try {
    if (await VentoLockService.requestUnlock()) {
      unlocked = true;
      window.close();
      return;
    }
    errorEl.textContent = "Authentication failed. Please try again.";
    errorEl.hidden = false;
  } finally {
    unlockBtn.disabled = false;
  }
});

signoutBtn.addEventListener("click", () => {
  // VentoLockService.lock() opens the login gate when it sees the token
  // is gone after this window closes.
  Services.prefs.clearUserPref("browser.logingate.accessToken");
  unlocked = true;
  window.close();
});

// Closing the window without authenticating must not bypass the lock:
// re-open it unless the whole browser is quitting.
window.addEventListener("unload", () => {
  if (!unlocked && !Services.startup.shuttingDown) {
    VentoLockService.lockSoon();
  }
});
