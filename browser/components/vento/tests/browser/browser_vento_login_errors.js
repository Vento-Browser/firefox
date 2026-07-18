/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * End-to-end test for the Vento password-manager error surface: a 401 from the
 * backend while about:logins is in use must show a visible error in the UI,
 * never fail silently.
 *
 * Requires the live vento-test-env stand (backend + vento_proxy) started via
 * vento-test-env/bootstrap.sh and the browser launched with
 * VENTO_TEST_NO_LOGIN_GATE=1 (see vento-test-env/run-autofill-test.sh). When
 * the stand parameters are absent from the environment the test skips itself.
 *
 * Flow verified here:
 *   1. With a valid token, creating a login through about:logins succeeds and
 *      no error banner is shown.
 *   2. After the access token is invalidated mid-session, the next mutation
 *      gets a 401. Re-auth is declined (promptReauth is stubbed to return
 *      false, standing in for a user who cancels the login gate), so the error
 *      must surface in the login-item error banner rather than being swallowed.
 */

"use strict";

const { VentoWebSocket } = ChromeUtils.importESModule(
  "resource:///modules/VentoWebSocket.sys.mjs"
);
const { VentoAuth } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoAuth.sys.mjs"
);

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

add_task(async function test_vento_login_error_surfaces_in_ui() {
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
  // case where the error must still reach the UI.
  const realPromptReauth = VentoAuth.promptReauth;
  VentoAuth.promptReauth = () => false;

  registerCleanupFunction(() => {
    VentoAuth.promptReauth = realPromptReauth;
    Services.prefs.clearUserPref("browser.logingate.serverUrl");
    Services.prefs.clearUserPref("browser.logingate.accessToken");
  });

  info("waiting for the proxy to be applied (ws status connected)");
  await waitForProxyConnected();

  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    url: "about:logins",
  });
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const browser = tab.linkedBrowser;

  // A create with the valid token succeeds and shows no error.
  await SpecialPowers.spawn(browser, [], async () => {
    const { ContentTaskUtils } = ChromeUtils.importESModule(
      "resource://testing-common/ContentTaskUtils.sys.mjs"
    );
    const loginList = Cu.waiveXrays(
      content.document.querySelector("login-list")
    );
    await ContentTaskUtils.waitForCondition(
      () => loginList.classList.contains("initialized"),
      "about:logins should finish its initial Vento load"
    );

    const loginItem = Cu.waiveXrays(
      content.document.querySelector("login-item")
    );
    const errorMessage = Cu.waiveXrays(
      loginItem.shadowRoot.querySelector(".error-message")
    );

    const before = loginList.shadowRoot.querySelectorAll(".list-item").length;
    loginList._createLoginButton.click();
    content.dispatchEvent(
      new content.CustomEvent(
        "AboutLoginsCreateLogin",
        Cu.cloneInto(
          {
            bubbles: true,
            detail: {
              origin: "https://vento-ok.example",
              username: "ok-user",
              password: "ok-passw0rd",
            },
          },
          content
        )
      )
    );

    await ContentTaskUtils.waitForCondition(
      () => loginList.shadowRoot.querySelectorAll(".list-item").length > before,
      "creating a login with a valid token should add it to the list"
    );
    Assert.ok(errorMessage.hidden, "no error banner after a successful create");
  });

  // Invalidate the token: subsequent Vento API calls get a 401. The ws is
  // already connected, so this pref change does not disturb the proxy.
  info("invalidating the access token to force a 401 on the next mutation");
  Services.prefs.setStringPref(
    "browser.logingate.accessToken",
    "invalid.token.value"
  );

  await SpecialPowers.spawn(browser, [], async () => {
    const { ContentTaskUtils } = ChromeUtils.importESModule(
      "resource://testing-common/ContentTaskUtils.sys.mjs"
    );
    const loginList = Cu.waiveXrays(
      content.document.querySelector("login-list")
    );
    const loginItem = Cu.waiveXrays(
      content.document.querySelector("login-item")
    );
    const errorMessage = Cu.waiveXrays(
      loginItem.shadowRoot.querySelector(".error-message")
    );

    loginList._createLoginButton.click();
    content.dispatchEvent(
      new content.CustomEvent(
        "AboutLoginsCreateLogin",
        Cu.cloneInto(
          {
            bubbles: true,
            detail: {
              origin: "https://vento-401.example",
              username: "denied-user",
              password: "denied-passw0rd",
            },
          },
          content
        )
      )
    );

    await ContentTaskUtils.waitForCondition(
      () => !errorMessage.hidden,
      "a 401 during a mutation must surface a visible error banner"
    );
    const text = errorMessage.querySelector("span:not([hidden])").textContent;
    Assert.ok(
      text.includes("401"),
      `error banner should mention the 401 status (got: ${text})`
    );
  });
});
