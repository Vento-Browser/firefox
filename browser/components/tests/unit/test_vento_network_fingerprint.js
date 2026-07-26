/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento network/protocol fingerprint tests (section 9 of
 * FINGERPRINTING_RESEARCH.md, deep dive in
 * browser/components/vento/fingerprint/network/NETWORK_FINGERPRINT_POC.md).
 *
 * The wire fingerprint (JA3/JA4, Akamai h2) can only be read off the wire, so
 * this unit test asserts what CAN be tested deterministically in CI: that the
 * module turns a profile into a stable, machine-independent pref set and wire
 * descriptor ("two machines, same config"), and that its honest residual-variance
 * verdict stays in sync with the documented native injection point.
 */

"use strict";

const { VentoNetworkFingerprint, DEFAULT_NETWORK_PROFILE, TLS } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/network/VentoNetworkFingerprint.sys.mjs"
  );

function prefsObject(fp) {
  return Object.fromEntries(fp.deterministicPrefs());
}

add_task(function test_identical_config_across_machines() {
  // Two independent instances built from the same profile == two machines.
  const m1 = new VentoNetworkFingerprint({ seedIrrelevant: true });
  const m2 = new VentoNetworkFingerprint({ seedIrrelevant: true });
  Assert.deepEqual(
    prefsObject(m1),
    prefsObject(m2),
    "same profile => byte-identical pref map on both machines"
  );
  Assert.equal(
    m1.wireDescriptor(),
    m2.wireDescriptor(),
    "same profile => identical wire descriptor"
  );
});

add_task(function test_custom_profile_changes_descriptor_and_prefs() {
  const base = new VentoNetworkFingerprint();
  const pq = new VentoNetworkFingerprint({ enableMlkem1024: true });
  Assert.notEqual(
    base.wireDescriptor(),
    pq.wireDescriptor(),
    "a key_share-affecting knob must change the wire descriptor"
  );
  Assert.equal(
    prefsObject(pq)["security.tls.enable_mlkem1024"],
    true,
    "override propagates into the pref map"
  );
  // But two instances of the SAME custom profile still agree.
  const pq2 = new VentoNetworkFingerprint({ enableMlkem1024: true });
  Assert.equal(pq.wireDescriptor(), pq2.wireDescriptor());
});

add_task(function test_pref_map_pins_all_variance_knobs() {
  const prefs = prefsObject(new VentoNetworkFingerprint());
  // Every knob the PoC identified as machine-to-machine variance must be pinned.
  const required = [
    "security.tls.version.min",
    "security.tls.version.max",
    "security.tls.version.fallback-limit",
    "security.tls.enable_kyber",
    "security.tls.enable_mlkem1024",
    "security.tls.client_hello.send_p256_keyshare",
    "security.tls.ech_grease_probability",
    "network.http.http2.enabled",
    "network.http.http2.send_NO_RFC7540_PRI",
    "network.http.http2.send_push_max_concurrent_frame",
    "network.http.http2.default-hpack-buffer",
    "network.http.http3.enable",
    "intl.accept_languages",
  ];
  for (const name of required) {
    Assert.ok(
      Object.prototype.hasOwnProperty.call(prefs, name),
      `pref map must pin ${name}`
    );
  }
});

add_task(function test_fallback_limit_matches_max_to_kill_downgrade() {
  const prefs = prefsObject(new VentoNetworkFingerprint());
  Assert.equal(
    prefs["security.tls.version.fallback-limit"],
    prefs["security.tls.version.max"],
    "fallback-limit pinned to max so the per-host intolerance cache cannot " +
      "downgrade the ClientHello on one machine but not another"
  );
});

add_task(function test_partial_ech_grease_probability_rejected() {
  // Any value strictly between 0 and 100 re-introduces per-connection presence
  // randomness and defeats the whole module.
  Assert.throws(
    () => new VentoNetworkFingerprint({ echGreaseProbability: 50 }),
    /must be 0 or 100/,
    "non-deterministic ECH-grease probability is rejected"
  );
  // The two deterministic endpoints are accepted.
  new VentoNetworkFingerprint({ echGreaseProbability: 0 });
  new VentoNetworkFingerprint({ echGreaseProbability: 100 });
});

add_task(function test_invalid_version_range_rejected() {
  Assert.throws(
    () =>
      new VentoNetworkFingerprint({
        tlsVersionMin: TLS.TLS1_3,
        tlsVersionMax: TLS.TLS1_2,
      }),
    /cannot exceed/,
    "min > max is rejected"
  );
});

add_task(function test_residual_variance_is_honest_and_documented() {
  const residual = new VentoNetworkFingerprint().residualVariance();
  const byId = Object.fromEntries(residual.map(r => [r.id, r]));

  // The one and only in-browser native patch the PoC admits.
  Assert.ok(byId["tls-grease-bytes"], "GREASE-bytes residual is reported");
  Assert.stringContains(
    byId["tls-grease-bytes"].injectionPoint,
    "tls13_ClientSetupGrease",
    "GREASE residual names the exact NSS hook so it can be lifted as a patch"
  );

  // The transport residual must be attributed to the proxy, not to a pref.
  Assert.ok(byId["tcp-ip-stack"], "TCP/IP residual is reported");
  Assert.stringContains(
    byId["tcp-ip-stack"].normalisedBy,
    "vento_proxy",
    "transport fingerprint is normalised by the proxy egress"
  );

  // Intolerance is claimed closed by the pinned fallback-limit, consistent with
  // test_fallback_limit_matches_max_to_kill_downgrade.
  Assert.ok(byId["tls-intolerance-cache"], "intolerance residual is reported");
  Assert.stringContains(
    byId["tls-intolerance-cache"].normalisedBy,
    "fallback-limit"
  );

  for (const r of residual) {
    for (const field of [
      "channel",
      "whyNotPrefable",
      "normalisedBy",
      "injectionPoint",
    ]) {
      Assert.ok(r[field] && r[field].length, `${r.id}.${field} is documented`);
    }
  }
});

add_task(function test_default_profile_is_frozen() {
  Assert.ok(
    Object.isFrozen(DEFAULT_NETWORK_PROFILE),
    "the fleet-wide default profile is frozen so it cannot drift at runtime"
  );
});
