/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento time / timers / TZ / locale / Math tests (section 7 of
 * FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoTimeLocale built from the same
 *     seed+profile ("two machines") return byte-for-byte identical spoofed
 *     values, prefs, descriptor and — crucially — the same DETERMINISTIC timer
 *     jitter, while a different seed gets an uncorrelated jitter stream;
 *   - the actual mitigation: every section-7 RFPTarget is in the overrides
 *     fragment; the defaults match what RFP forces (Reykjavik / en-US / 1ms
 *     floor); the timer reducer collapses sub-resolution timing (floor to grid)
 *     both with jitter off and on.
 */

"use strict";

const { VentoTimeLocale, SECTION7_TARGETS, DEFAULT_TIME_LOCALE_PROFILE } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoTimeLocale.sys.mjs"
  );
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

const SEED = "shared-vento-seed-2f9c";

function machine(profile, seed = SEED) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoTimeLocale({ seed, profile });
}

add_task(function test_empty_seed_rejected() {
  Assert.throws(
    () => new VentoTimeLocale({ seed: "" }),
    /non-empty string seed/,
    "empty seed is rejected"
  );
});

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-7 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-7 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-7 descriptor identical on two machines"
  );
});

add_task(function test_defaults_match_rfp_constants() {
  const v = machine().getSpoofedValues();
  Assert.equal(
    v.timezone,
    "Atlantic/Reykjavik",
    "default timezone equals RFP's forced zone"
  );
  Assert.equal(v.locale, "en-US", "default locale equals RFP's forced locale");
  Assert.equal(v.mathFdlibm, true, "fdlibm math always on");
  Assert.equal(v.timerResolutionUs, 1000, "default resolution is 1ms (RFP)");
  Assert.equal(v.timerJitter, false, "default jitter off (floor-only)");
  Assert.equal(
    v.timerMidpointSeedHex,
    null,
    "no midpoint seed exposed while jitter is off"
  );
});

add_task(function test_overrides_fragment_covers_every_section7_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION7_TARGETS.length,
    "one override token per section-7 target"
  );
  for (const target of SECTION7_TARGETS) {
    Assert.ok(
      parts.includes(`+${target}`),
      `overrides fragment enables ${target}`
    );
  }
  Assert.ok(
    parts.every(t => t.startsWith("+")),
    "every override token is a '+enable', never a '-disable'"
  );
});

add_task(function test_deterministic_prefs_names_and_values() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("privacy.resistFingerprinting.reduceTimerPrecision.microseconds"),
    1000,
    "resolution pref pinned to profile value"
  );
  Assert.equal(
    prefs.get("privacy.resistFingerprinting.reduceTimerPrecision.jitter"),
    false,
    "jitter pref off for the default deterministic-floor path"
  );
  // TZ/locale are applied at the native return-value hook, not via a pref.
  Assert.ok(
    !prefs.has("privacy.fingerprintingProtection.overrides"),
    "deterministicPrefs does not write the overrides pref directly"
  );
});

add_task(function test_timer_floor_collapses_sub_resolution_timing() {
  const m = machine({ timerResolutionUs: 1000 });
  // Every microsecond inside one 1ms bucket must reduce to the same value: this
  // is the mitigation (sub-millisecond timing — the hardware/timing-attack
  // signal — is destroyed).
  for (const t of [1_000_000, 1_000_001, 1_000_499, 1_000_999]) {
    Assert.equal(
      m.quantizeTimerUs(t),
      1_000_000,
      `t=${t}us floors to the 1ms grid`
    );
  }
  Assert.equal(m.quantizeTimerUs(1_001_000), 1_001_000, "next bucket edge");
});

add_task(function test_timer_jitter_is_deterministic_across_machines() {
  const profile = { timerJitter: true, timerResolutionUs: 1000 };
  const m1 = machine(profile);
  const m2 = machine(profile);
  Assert.equal(
    m1.timerMidpointSeedHex(),
    m2.timerMidpointSeedHex(),
    "same seed => same midpoint seed on two machines"
  );
  Assert.equal(
    m1.timerMidpointSeedHex().length,
    32,
    "midpoint seed is 16 bytes (128 bits) of hex"
  );
  // With jitter ON the reduced value can round up, but two machines with the same
  // profile must agree on every sample — that is the whole guarantee.
  for (let t = 5_000_000; t < 5_000_050; t++) {
    Assert.equal(
      m1.quantizeTimerUs(t, 0n),
      m2.quantizeTimerUs(t, 0n),
      `jittered reduction identical across machines at t=${t}`
    );
  }
});

add_task(function test_timer_jitter_differs_by_seed() {
  const profile = { timerJitter: true, timerResolutionUs: 1000 };
  const a = machine(profile, "seed-A");
  const b = machine(profile, "seed-B");
  Assert.notEqual(
    a.timerMidpointSeedHex(),
    b.timerMidpointSeedHex(),
    "different seeds derive different midpoint seeds"
  );
  // Result still floors onto the grid; jitter only ever pushes to the next edge.
  const res = 1000;
  for (let t = 7_000_000; t < 7_000_010; t++) {
    const q = a.quantizeTimerUs(t, 0n);
    Assert.equal(q % res, 0, "jittered result lands on the resolution grid");
    Assert.ok(
      q === Math.floor(t / res) * res || q === Math.floor(t / res) * res + res,
      "jitter only clamps down or one step up"
    );
  }
});

add_task(function test_fromProfile_threads_section7_fields_only() {
  const fp = new VentoFingerprintProfile({
    seed: SEED,
    fields: {
      timezone: "Europe/Berlin",
      locale: "de-DE",
      userAgent: "irrelevant",
    },
  });
  const tl = VentoTimeLocale.fromProfile(fp);
  const v = tl.getSpoofedValues();
  Assert.equal(v.timezone, "Europe/Berlin", "timezone threaded from profile");
  Assert.equal(v.locale, "de-DE", "locale threaded from profile");
  Assert.equal(
    v.timerResolutionUs,
    DEFAULT_TIME_LOCALE_PROFILE.timerResolutionUs,
    "unspecified section-7 fields keep the fleet-wide default"
  );
  // The jitter midpoint seed comes from the profile's master seed.
  Assert.equal(
    tl.timerMidpointSeedHex(),
    machine({}, SEED).timerMidpointSeedHex(),
    "midpoint seed derives from the profile master seed"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => machine({ timezone: "" }),
    /timezone must be a non-empty string/,
    "empty timezone rejected"
  );
  Assert.throws(
    () => machine({ locale: 42 }),
    /locale must be a non-empty string/,
    "non-string locale rejected"
  );
  Assert.throws(
    () => machine({ timerResolutionUs: 0 }),
    /timerResolutionUs must be a positive integer/,
    "non-positive resolution rejected"
  );
  Assert.throws(
    () => machine({ timerJitter: "yes" }),
    /timerJitter must be a boolean/,
    "non-boolean jitter rejected"
  );
});

add_task(function test_injection_points_cover_every_target() {
  const points = machine().injectionPoints();
  const covered = new Set();
  for (const pt of points) {
    for (const t of pt.target.split(" / ")) {
      covered.add(t.trim());
    }
  }
  for (const target of SECTION7_TARGETS) {
    Assert.ok(
      covered.has(target),
      `injectionPoints() documents a hook for ${target}`
    );
  }
});

add_task(function test_residual_variance_is_native_and_scoped() {
  const residual = machine().residualVariance();
  Assert.greater(residual.length, 0, "residual variance is enumerated");
  for (const item of residual) {
    Assert.ok(item.id, "residual item has an id");
    Assert.ok(
      item.whyNotTargetOnly,
      "residual item explains why not target-only"
    );
    Assert.ok(
      item.injectionPoint,
      "residual item names a native injection point"
    );
  }
});
