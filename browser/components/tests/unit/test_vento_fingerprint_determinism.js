/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento fingerprint determinism tests.
 *
 * These simulate "two different machines" by constructing two independent
 * VentoFingerprintProfile instances from the same profile data (the same way two
 * users with the same Vento profile on two computers would) and asserting the
 * derived noise seeds and spoofed values are byte-for-byte identical. This is the
 * CI-checkable half of the identity guarantee from FINGERPRINTING_RESEARCH.md;
 * the hardware-dependent half (real canvas/WebGL/audio) is covered by the E2E
 * stand in vento-test-env/fingerprint/.
 */

"use strict";

const { VentoFingerprintProfile, cyrb128, sfc32 } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

const SEED = "shared-vento-seed-2f9c";
const ORIGINS = ["https://amazon.com", "https://example.org", ""];
const SURFACES = ["canvas", "webgl", "audio", "static"];

function machine(seed, fields) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoFingerprintProfile({ seed, fields });
}

add_task(function test_prng_primitives_are_deterministic() {
  Assert.deepEqual(
    cyrb128("hello world"),
    cyrb128("hello world"),
    "cyrb128 is a pure function of its input"
  );
  Assert.notDeepEqual(
    cyrb128("hello world"),
    cyrb128("hello worlD"),
    "cyrb128 diffuses a one-char change"
  );

  const rngA = sfc32(1, 2, 3, 4);
  const rngB = sfc32(1, 2, 3, 4);
  const seqA = Array.from({ length: 32 }, () => rngA());
  const seqB = Array.from({ length: 32 }, () => rngB());
  Assert.deepEqual(seqA, seqB, "sfc32 with equal seeds yields equal sequences");
  for (const x of seqA) {
    Assert.ok(x >= 0 && x < 1, "sfc32 output stays in [0, 1)");
  }
});

add_task(function test_surface_seeds_identical_across_machines() {
  const m1 = machine(SEED);
  const m2 = machine(SEED);
  for (const surface of SURFACES) {
    for (const origin of ORIGINS) {
      Assert.equal(
        m1.surfaceSeedHex(surface, origin),
        m2.surfaceSeedHex(surface, origin),
        `${surface}@${origin} seed identical on two machines`
      );
    }
  }
});

add_task(function test_session_key_identical_across_machines() {
  // The browsing-session key is the value the native injection point
  // (nsRFPService::GetBrowsingSessionKey) installs in place of the random
  // per-session UUID. Two machines with the same seed must derive the same key.
  const m1 = machine(SEED);
  const m2 = machine(SEED);
  for (const origin of ORIGINS) {
    Assert.equal(
      m1.sessionKeyId(origin),
      m2.sessionKeyId(origin),
      `session key identical on two machines for ${origin}`
    );
    Assert.ok(
      /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/.test(
        m1.sessionKeyId(origin)
      ),
      "session key is a well-formed nsID string"
    );
  }
  Assert.notEqual(
    m1.sessionKeyId("https://amazon.com"),
    m1.sessionKeyId("https://example.org"),
    "session key differs per origin"
  );
});

add_task(function test_session_key_matches_native_golden() {
  // Golden vectors shared with the C++ gtest
  // (browser/components/vento/fingerprint/native/gtest/TestVentoFingerprintSeed.cpp).
  // If these diverge, the JS reference and the native injection point disagree.
  Assert.equal(
    new VentoFingerprintProfile({ seed: "test-seed" }).sessionKeyId(""),
    "{3539ee32-9915-7812-bd79-20631155b643}",
    "session key matches native golden (test-seed)"
  );
  Assert.equal(
    new VentoFingerprintProfile({
      seed: "vento-default-profile-v1",
    }).sessionKeyId("^userContextId=1"),
    "{cb55f5f4-50c4-6968-2700-bafdbc912661}",
    "session key matches native golden (default profile)"
  );
});

add_task(function test_noise_streams_identical_across_machines() {
  const m1 = machine(SEED);
  const m2 = machine(SEED);
  for (const origin of ORIGINS) {
    const r1 = m1.noiseRng("canvas", origin);
    const r2 = m2.noiseRng("canvas", origin);
    const s1 = Array.from({ length: 256 }, () => r1());
    const s2 = Array.from({ length: 256 }, () => r2());
    Assert.deepEqual(
      s1,
      s2,
      `256-sample canvas noise stream identical for ${origin}`
    );
  }
});

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine(SEED);
  const m2 = machine(SEED);
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "derived static spoofed values identical on two machines"
  );
});

add_task(function test_explicit_fields_win_and_are_stable() {
  const fields = {
    userAgent: "Mozilla/5.0 custom",
    hardwareConcurrency: 24,
    screen: { width: 2560, height: 1440, colorDepth: 30 },
    timezone: "Europe/Berlin",
  };
  const v1 = machine(SEED, fields).getSpoofedValues();
  const v2 = machine(SEED, fields).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-field profile is reproducible");
  Assert.equal(v1.userAgent, fields.userAgent, "explicit userAgent wins");
  Assert.equal(v1.hardwareConcurrency, 24, "explicit hwConcurrency wins");
  Assert.equal(v1.timezone, "Europe/Berlin", "explicit timezone wins");
});

add_task(function test_different_seeds_diverge() {
  const a = machine(SEED);
  const b = machine("a-completely-different-seed");
  Assert.notEqual(
    a.canvasSeedHex("https://amazon.com"),
    b.canvasSeedHex("https://amazon.com"),
    "different profiles must NOT collide to the same canvas seed"
  );
});

add_task(function test_per_origin_keying() {
  const m = machine(SEED);
  Assert.notEqual(
    m.canvasSeedHex("https://amazon.com"),
    m.canvasSeedHex("https://evil-tracker.example"),
    "canvas seed is keyed per-origin within one profile"
  );
});

add_task(function test_export_import_roundtrip_is_identical() {
  const original = machine(SEED, { platform: "Linux x86_64", deviceMemory: 8 });
  const restored = VentoFingerprintProfile.import(
    JSON.parse(JSON.stringify(original.export()))
  );
  Assert.ok(
    original.equals(restored),
    "profile survives export -> JSON -> import unchanged"
  );
  Assert.deepEqual(
    original.getSpoofedValues(),
    restored.getSpoofedValues(),
    "restored profile produces identical spoofed values"
  );
  for (const origin of ORIGINS) {
    Assert.equal(
      original.canvasSeedHex(origin),
      restored.canvasSeedHex(origin),
      `restored profile canvas seed identical for ${origin}`
    );
  }
});

add_task(function test_default_profile_is_stable() {
  Assert.ok(
    VentoFingerprintProfile.DEFAULT.equals(VentoFingerprintProfile.DEFAULT),
    "DEFAULT profile is a stable constant"
  );
});

add_task(function test_empty_seed_rejected() {
  Assert.throws(
    () => new VentoFingerprintProfile({ seed: "" }),
    /non-empty string seed/,
    "empty seed is rejected so there is never an undefined-entropy profile"
  );
});
