/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const params = new URLSearchParams(window.location.search);
const downloadUrl = params.get("download") ?? "";

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
  // The gate lives inside gVentoUpdateOverlay; tell VentoWebSocket to hide the
  // overlay in every browser window rather than closing a standalone window.
  // The download tab opens on the allow-listed host, so the browser stays
  // usable to fetch the update.
  const { VentoWebSocket } = ChromeUtils.importESModule(
    "resource:///modules/VentoWebSocket.sys.mjs"
  );
  VentoWebSocket.dismissUpdate();
});

document.getElementById("quit-btn").addEventListener("click", () => {
  Services.startup.quit(Services.startup.eAttemptQuit);
});
