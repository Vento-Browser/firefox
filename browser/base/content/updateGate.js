/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const params = new URLSearchParams(window.location.search);
const downloadUrl = params.get("download") ?? "";
let resolved = false;

document.getElementById("current-version").textContent =
  params.get("current") ?? Services.appinfo.version;
document.getElementById("required-version").textContent =
  params.get("required") ?? "";

document.getElementById("download-btn").addEventListener("click", () => {
  if (downloadUrl) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (win) {
      win.switchToTabHavingURI(downloadUrl, true);
    }
  }
  resolved = true;
  window.close();
});

document.getElementById("quit-btn").addEventListener("click", () => {
  Services.startup.quit(Services.startup.eAttemptQuit);
});

// Closing the window without choosing means the browser cannot be used
// (the proxy stays in blocking state), so treat it like Quit. The download
// path sets `resolved` so the browser stays alive to fetch the update.
window.addEventListener("unload", () => {
  if (!resolved) {
    Services.startup.quit(Services.startup.eAttemptQuit);
  }
});
