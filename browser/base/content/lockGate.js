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

signoutBtn.addEventListener("click", async () => {
  signoutBtn.disabled = true;
  const { VentoAuth } = ChromeUtils.importESModule(
    "chrome://browser/content/vento/VentoAuth.sys.mjs"
  );
  try {
    // Seals the encrypted vault and wipes browsing data. VentoLockService
    // .lock() opens the login gate when it sees the token is gone after this
    // window closes.
    await VentoAuth.logout({ promptLogin: false });
  } finally {
    unlocked = true;
    window.close();
  }
});

// Closing the window without authenticating must not bypass the lock:
// re-open it unless the whole browser is quitting.
window.addEventListener("unload", () => {
  if (!unlocked && !Services.startup.shuttingDown) {
    VentoLockService.lockSoon();
  }
});
