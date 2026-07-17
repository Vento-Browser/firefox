/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * End-to-end DOM autofill test for VentoFormDetectorChild/Parent.
 *
 * Requires the live vento-test-env stand (backend + vento_proxy with
 * VENTO_TEST_HOST_MAP) started via vento-test-env/bootstrap.sh, and the
 * browser launched with VENTO_TEST_NO_LOGIN_GATE=1.  The stand parameters
 * are read from the environment (see vento-test-env/env.sh); when they are
 * absent the test skips itself.
 *
 * Flow verified here:
 *   1. Credential seeded on the backend for http://mochi.test:8888.
 *   2. Page with a login form loads through vento_proxy (locked SOCKS prefs,
 *      host map resolves mochi.test to 127.0.0.1).
 *   3. VentoFormDetectorChild fills username with the plaintext and password
 *      with an opaque VENTO_CRED:* token — the plaintext never reaches the
 *      content process.
 *   4. On submit VentoNetworkObserver swaps the token for the real password
 *      in the HTTP body; the echo server proves the wire carried the
 *      plaintext and not the token.
 */

"use strict";

const { VentoLoginCache } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoLoginCache.sys.mjs"
);
const { VentoWebSocket } = ChromeUtils.importESModule(
  "resource:///modules/VentoWebSocket.sys.mjs"
);

const TEST_ORIGIN = "http://mochi.test:8888";
const TEST_PATH =
  "/browser/browser/components/vento/tests/browser/form_page.html";
const TEST_USERNAME = "vento-e2e-user";
const TEST_PASSWORD = "S3cret-passw0rd-E2E!";

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

async function seedCredential(serverUrl, accessToken) {
  const res = await fetch(`${serverUrl}/api/browser-logins/manual`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      origin: TEST_ORIGIN,
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      username_field: "username",
      password_field: "password",
    }),
  });
  Assert.ok(res.ok, `seeding credential should succeed (got ${res.status})`);
  return res.json();
}

add_task(async function test_vento_dom_autofill() {
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

  // Simulate a completed login: the loginGate normally writes these prefs.
  // Setting the token triggers VentoWebSocket's pref observer, which
  // connects to the backend and applies the real SOCKS proxy.
  Services.prefs.setStringPref("browser.logingate.serverUrl", serverUrl);
  Services.prefs.setStringPref("browser.logingate.accessToken", accessToken);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("browser.logingate.serverUrl");
    Services.prefs.clearUserPref("browser.logingate.accessToken");
  });

  info("waiting for the proxy to be applied (ws status connected)");
  await waitForProxyConnected();
  Assert.equal(
    Services.prefs.getIntPref("network.proxy.socks_port"),
    parseInt(Services.env.get("VENTO_PROXY_PORT") || "1080", 10),
    "real SOCKS proxy should be applied after auth_ok"
  );

  const guid = await seedCredential(serverUrl, accessToken);
  info(`credential seeded, guid: ${guid}`);
  await VentoLoginCache.invalidate();
  Assert.ok(
    VentoLoginCache.findForOrigin(TEST_ORIGIN).length,
    "seeded credential should be visible in the login cache"
  );

  await BrowserTestUtils.withNewTab(TEST_ORIGIN + TEST_PATH, async browser => {
    info("page loaded through vento_proxy, waiting for autofill");

    const filled = await SpecialPowers.spawn(browser, [], async () => {
      const { ContentTaskUtils } = ChromeUtils.importESModule(
        "resource://testing-common/ContentTaskUtils.sys.mjs"
      );
      const doc = content.document;
      const pw = doc.getElementById("password");
      await ContentTaskUtils.waitForCondition(
        () => pw.value.startsWith("VENTO_CRED:"),
        "password field should be filled with an opaque fill token"
      );
      return {
        username: doc.getElementById("username").value,
        passwordValue: pw.value,
      };
    });

    Assert.equal(
      filled.username,
      "vento-e2e-user",
      "username field should be filled with the plaintext username"
    );
    Assert.ok(
      filled.passwordValue.startsWith("VENTO_CRED:"),
      "password field should contain the fill token"
    );
    Assert.ok(
      !filled.passwordValue.includes("S3cret-passw0rd-E2E!"),
      "plaintext password must never appear in the content process"
    );

    // Submit the form; the token must be replaced with the real password at
    // the HTTP layer before the request leaves the browser.
    const loaded = BrowserTestUtils.browserLoaded(browser, false, url =>
      url.includes("submit.sjs")
    );
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("login-form").submit();
    });
    await loaded;

    const echoed = await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.textContent
    );
    info(`echo server response: ${echoed}`);
    Assert.ok(
      echoed.startsWith("BODY:"),
      "echo endpoint should return the request body"
    );
    Assert.ok(
      echoed.includes(encodeURIComponent(TEST_PASSWORD)) ||
        echoed.includes(TEST_PASSWORD),
      "submitted body should contain the real password"
    );
    Assert.ok(
      !echoed.includes("VENTO_CRED"),
      "submitted body must not contain the fill token"
    );
    Assert.ok(
      echoed.includes(TEST_USERNAME),
      "submitted body should contain the username"
    );
  });
});
