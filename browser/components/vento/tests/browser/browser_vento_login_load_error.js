/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * End-to-end test for the Vento password-manager load-failure surface: when the
 * initial about:logins list cannot be fetched from the backend, the UI must say
 * so with a visible notification bar instead of rendering an empty list that
 * reads as "you have no passwords".
 *
 * Requires the live vento-test-env stand (backend + vento_proxy) started via
 * vento-test-env/bootstrap.sh and the browser launched through
 * vento-test-env/run-autofill-test.sh. When the stand parameters are absent
 * from the environment the test skips itself.
 *
 * Flow verified here:
 *   1. With an invalid token and re-auth declined, opening about:logins fails
 *      to load the list. A "couldn't load your passwords" notification bar is
 *      shown (value vento-logins-load-error).
 *   2. After the token is restored and a reload is requested, the load
 *      succeeds and the notification bar is removed.
 */

"use strict";

const { VentoWebSocket } = ChromeUtils.importESModule(
  "resource:///modules/VentoWebSocket.sys.mjs"
);
const { VentoAuth } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoAuth.sys.mjs"
);

const LOAD_ERROR_NOTIFICATION_ID = "vento-logins-load-error";

function standEnv() {
  return {
    serverUrl: Services.env.get("VENTO_BACKEND_URL"),
    accessToken: Services.env.get("VENTO_ACCESS_TOKEN"),
  };
}

async function waitForProxyConnected() {
  if (VentoWebSocket.status === "connected") {
    return;
  }
  await new Promise(resolve => {
    const observer = () => {
      if (VentoWebSocket.status === "connected") {
        Services.obs.removeObserver(observer, "vento-ws-status-changed");
        resolve();
      }
    };
    Services.obs.addObserver(observer, "vento-ws-status-changed");
  });
}

add_task(async function test_vento_login_load_error_surfaces_in_ui() {
  const { serverUrl, accessToken } = standEnv();
  if (!serverUrl || !accessToken) {
    info(
      "VENTO_BACKEND_URL / VENTO_ACCESS_TOKEN not set — start the stand " +
        "with vento-test-env/bootstrap.sh and run through " +
        "vento-test-env/run-autofill-test.sh"
    );
    Assert.ok(true, "skipped: vento-test-env stand is not running");
    return;
  }

  Services.prefs.setStringPref("browser.logingate.serverUrl", serverUrl);
  Services.prefs.setStringPref("browser.logingate.accessToken", accessToken);

  // Decline re-authentication when a 401 triggers it: promptReauth() would
  // otherwise spin a nested event loop on the modal login gate and hang the
  // test. Returning false models the user cancelling the gate, which is the
  // case where the load must still fail loudly.
  const realPromptReauth = VentoAuth.promptReauth;
  VentoAuth.promptReauth = () => false;

  registerCleanupFunction(() => {
    VentoAuth.promptReauth = realPromptReauth;
    Services.prefs.clearUserPref("browser.logingate.serverUrl");
    Services.prefs.clearUserPref("browser.logingate.accessToken");
  });

  info("waiting for the proxy to be applied (ws status connected)");
  await waitForProxyConnected();

  // Invalidate the token so the very first list load gets a 401 and, with
  // re-auth declined, fails outright.
  info("invalidating the access token to force the initial load to fail");
  Services.prefs.setStringPref(
    "browser.logingate.accessToken",
    "invalid.token.value"
  );

  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: "about:logins",
  });
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const browser = tab.linkedBrowser;
  const notificationBox = gBrowser.getNotificationBox(browser);

  await BrowserTestUtils.waitForCondition(
    () => notificationBox.getNotificationWithValue(LOAD_ERROR_NOTIFICATION_ID),
    "a failed initial load must show the load-error notification bar"
  );
  Assert.ok(
    notificationBox.getNotificationWithValue(LOAD_ERROR_NOTIFICATION_ID),
    "load-error notification is shown when the list cannot be fetched"
  );

  // Restore the valid token and ask about:logins to reload. The load now
  // succeeds and the notification must be cleared.
  info("restoring the token and reloading the login list");
  Services.prefs.setStringPref("browser.logingate.accessToken", accessToken);
  Services.obs.notifyObservers(null, "passwordmgr-reload-all");

  await BrowserTestUtils.waitForCondition(
    () => !notificationBox.getNotificationWithValue(LOAD_ERROR_NOTIFICATION_ID),
    "a successful reload must remove the load-error notification bar"
  );
  Assert.ok(
    !notificationBox.getNotificationWithValue(LOAD_ERROR_NOTIFICATION_ID),
    "load-error notification is cleared once the list loads again"
  );
});
