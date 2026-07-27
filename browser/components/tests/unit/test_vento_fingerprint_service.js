/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento fingerprint service tests — the browser-side of backend profile delivery.
 *
 * The service is exercised against an in-memory pref branch and a mock backend
 * (both injected), so the full pull -> import -> cache -> apply flow is verified
 * with no network and no live nsRFPService. This is what makes "выдача/синхронизация
 * профиля" a CI-checkable path.
 */

"use strict";

const { VentoFingerprintService, ACTIVE_PROFILE_PREF } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoFingerprintService.sys.mjs"
  );
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

/** Minimal in-memory stand-in for Services.prefs, typed like the real branch. */
function fakePrefs() {
  const store = new Map();
  return {
    store,
    getStringPref: (k, d) => (store.has(k) ? store.get(k) : d),
    setStringPref: (k, v) => store.set(k, v),
    setBoolPref: (k, v) => store.set(k, v),
    setIntPref: (k, v) => store.set(k, v),
  };
}

const SEED = "service-test-seed";

function service(fetchImpl) {
  return new VentoFingerprintService({
    prefs: fakePrefs(),
    fetch: fetchImpl,
  });
}

add_task(function test_save_and_load_local_roundtrip() {
  const svc = service();
  Assert.equal(svc.loadLocal(), null, "no cached profile initially");

  const profile = new VentoFingerprintProfile({
    seed: SEED,
    label: "Amazon desktop",
    fields: { platform: "Win32" },
  });
  svc.saveLocal(profile);

  const cached = svc.prefs.store.get(ACTIVE_PROFILE_PREF);
  Assert.ok(cached && cached.includes(SEED), "profile is cached as JSON");

  const restored = svc.loadLocal();
  Assert.ok(restored, "cached profile loads back");
  Assert.ok(profile.equals(restored), "roundtrip preserves the profile");
  Assert.equal(restored.label, "Amazon desktop", "label survives roundtrip");
});

add_task(function test_apply_profile_writes_typed_prefs() {
  const svc = service();
  const profile = new VentoFingerprintProfile({ seed: SEED });
  const applied = svc.applyProfile(profile);

  Assert.strictEqual(
    svc.prefs.store.get("privacy.fingerprintingProtection"),
    true,
    "bool pref written with correct type"
  );
  Assert.equal(
    svc.prefs.store.get("vento.fingerprint.seed"),
    SEED,
    "seed string pref written"
  );
  Assert.strictEqual(
    typeof svc.prefs.store.get("privacy.fingerprintingProtection.overrides"),
    "string",
    "overrides string pref written"
  );
  Assert.greater(applied.size, 3, "applyProfile returns the composed map");
});

add_task(async function test_fetch_remote_imports_backend_shape() {
  const backendProfile = {
    version: 1,
    seed: SEED,
    label: "from backend",
    fields: { timezone: "Europe/Berlin" },
  };
  let seenUrl, seenAuth;
  const svc = service(async (url, opts) => {
    seenUrl = url;
    seenAuth = opts.headers.Authorization;
    return {
      ok: true,
      status: 200,
      json: async () => backendProfile,
    };
  });

  const profile = await svc.fetchRemote("https://api.vento.test/", "tok123");
  Assert.equal(
    seenUrl,
    "https://api.vento.test/api/fingerprint/profile",
    "trailing slash trimmed and path appended"
  );
  Assert.equal(seenAuth, "Bearer tok123", "bearer token sent");
  Assert.equal(profile.seed, SEED, "backend profile imported");
  Assert.equal(profile.fields.timezone, "Europe/Berlin", "fields imported");
});

add_task(async function test_fetch_remote_throws_on_http_error() {
  const svc = service(async () => ({ ok: false, status: 503 }));
  await Assert.rejects(
    svc.fetchRemote("https://api.vento.test", "t"),
    /HTTP 503/,
    "a non-ok response is an error, not a silent empty profile"
  );
});

add_task(async function test_push_remote_sends_versioned_body() {
  let body;
  const svc = service(async (url, opts) => {
    body = JSON.parse(opts.body);
    Assert.equal(opts.method, "PUT", "push uses PUT");
    return { ok: true, status: 200 };
  });
  await svc.pushRemote(
    "https://api.vento.test",
    "t",
    new VentoFingerprintProfile({ seed: SEED })
  );
  Assert.equal(body.seed, SEED, "pushed body carries the seed");
  Assert.ok(Number.isInteger(body.version), "pushed body is versioned");
});

add_task(async function test_sync_pulls_caches_and_applies() {
  const svc = service(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: 1, seed: SEED, fields: {} }),
  }));
  const profile = await svc.sync("https://api.vento.test", "t");
  Assert.equal(profile.seed, SEED, "sync returns the pulled profile");
  Assert.ok(svc.loadLocal(), "sync cached the profile locally");
  Assert.equal(
    svc.prefs.store.get("vento.fingerprint.seed"),
    SEED,
    "sync applied the profile to prefs"
  );
});
