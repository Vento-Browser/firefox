/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * VentoSessionVault tests.
 *
 * Covers the encrypted logout vault: sealing writes an AES-GCM encrypted
 * file with no plaintext traces, restore() round-trips cookies and history,
 * a vault sealed under a different user's key is discarded, and sealing is
 * skipped entirely when no key is available.
 */

"use strict";

const { VentoSessionVault } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoSessionVault.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);

const COOKIE_HOST = "vault-test.example.com";
const COOKIE_VALUE = "vault-cookie-value-marker";
const HISTORY_URL = "https://vault-history.example.com/secret-page";
const HISTORY_TITLE = "Vault history marker";

do_get_profile();

function makeKey(fill) {
  return new Uint8Array(32).fill(fill);
}

async function clearEverything() {
  Services.cookies.removeAll();
  await PlacesUtils.history.clear();
}

function findCookie() {
  return Services.cookies.cookies.find(c => c.host == COOKIE_HOST);
}

add_task(async function test_seal_writes_encrypted_file() {
  Services.cookies.add(
    COOKIE_HOST,
    "/",
    "vault-test",
    COOKIE_VALUE,
    true,
    false,
    false,
    Date.now() + 3600_000,
    {},
    Ci.nsICookie.SAMESITE_UNSET,
    Ci.nsICookie.SCHEME_HTTPS
  );
  await PlacesUtils.history.insert({
    url: HISTORY_URL,
    title: HISTORY_TITLE,
    visits: [
      { date: new Date(), transition: PlacesUtils.history.TRANSITIONS.LINK },
    ],
  });

  VentoSessionVault._keyBytes = makeKey(1);
  Assert.ok(await VentoSessionVault.seal(), "seal() wrote a vault");

  const raw = await IOUtils.read(VentoSessionVault._vaultPath);
  const asText = new TextDecoder("latin1").decode(raw);
  Assert.ok(
    !asText.includes(COOKIE_VALUE),
    "cookie value is not readable in the vault file"
  );
  Assert.ok(
    !asText.includes("vault-history.example.com"),
    "history URL is not readable in the vault file"
  );
  Assert.equal(asText.slice(0, 5), "VVLT1", "vault file carries the magic");
});

add_task(async function test_restore_roundtrip() {
  await clearEverything();
  Assert.equal(findCookie(), undefined, "cookie gone after wipe");
  Assert.equal(
    await PlacesUtils.history.fetch(HISTORY_URL),
    null,
    "history gone after wipe"
  );

  // SessionStore never initializes in xpcshell (no browser windows), so stub
  // out the tab-restore step and only verify it receives the decrypted state.
  const originalRestoreSession = VentoSessionVault._restoreSession;
  let restoredSessionState;
  VentoSessionVault._restoreSession = async state => {
    restoredSessionState = state;
  };

  VentoSessionVault._keyBytes = makeKey(1);
  try {
    await VentoSessionVault.restore();
  } finally {
    VentoSessionVault._restoreSession = originalRestoreSession;
  }
  Assert.notEqual(
    restoredSessionState,
    undefined,
    "tab-restore step received the decrypted session state"
  );

  const cookie = findCookie();
  Assert.ok(cookie, "cookie restored");
  Assert.equal(cookie.value, COOKIE_VALUE, "cookie value restored");
  Assert.ok(cookie.isSecure, "cookie flags restored");

  const page = await PlacesUtils.history.fetch(HISTORY_URL);
  Assert.ok(page, "history entry restored");
  Assert.equal(page.title, HISTORY_TITLE, "history title restored");

  Assert.ok(
    !(await IOUtils.exists(VentoSessionVault._vaultPath)),
    "vault file deleted after restore"
  );
});

add_task(async function test_wrong_key_discards_vault() {
  VentoSessionVault._keyBytes = makeKey(1);
  Assert.ok(await VentoSessionVault.seal(), "sealed under key A");

  await clearEverything();
  const originalRestoreSession = VentoSessionVault._restoreSession;
  VentoSessionVault._restoreSession = async () => {};
  VentoSessionVault._keyBytes = makeKey(2);
  try {
    await VentoSessionVault.restore();
  } finally {
    VentoSessionVault._restoreSession = originalRestoreSession;
  }

  Assert.equal(
    findCookie(),
    undefined,
    "nothing restored under a different key"
  );
  Assert.ok(
    !(await IOUtils.exists(VentoSessionVault._vaultPath)),
    "undecryptable vault is discarded"
  );
});

add_task(async function test_seal_without_key_writes_nothing() {
  VentoSessionVault._keyBytes = null;
  Services.prefs.clearUserPref("browser.logingate.accessToken");
  Services.prefs.clearUserPref("browser.logingate.serverUrl");

  Assert.equal(
    await VentoSessionVault.seal(),
    false,
    "seal() reports failure without a key"
  );
  Assert.ok(
    !(await IOUtils.exists(VentoSessionVault._vaultPath)),
    "no vault file is written without a key"
  );
});
