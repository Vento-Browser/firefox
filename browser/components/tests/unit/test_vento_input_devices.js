/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento input devices / sensors / media devices tests (section 6 of
 * FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoInputDevices built from the
 *     same profile ("two machines") return byte-for-byte identical spoofed
 *     values, prefs and descriptor;
 *   - the actual mitigation: every section-6 RFPTarget is present in the
 *     overrides fragment, and the defaults are the deny-by-default constants that
 *     enabling those targets produces (0 touch points, one device of each kind,
 *     no gamepads/sensors, "unknown" connection, 50 GiB quota, hidden battery).
 */

"use strict";

const { VentoInputDevices, SECTION6_TARGETS, DEFAULT_INPUT_PROFILE } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoInputDevices.sys.mjs"
  );
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

function machine(profile) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoInputDevices(profile);
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-6 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-6 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-6 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section6_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION6_TARGETS.length,
    "one override token per section-6 target"
  );
  for (const target of SECTION6_TARGETS) {
    Assert.ok(
      parts.includes(`+${target}`),
      `overrides fragment enables ${target}`
    );
  }
  // Every token is an explicit enable so the fragment can only ever ADD targets
  // when merged into the profile-wide overrides string.
  Assert.ok(
    parts.every(t => t.startsWith("+")),
    "every override token is a '+enable', never a '-disable'"
  );
});

add_task(function test_defaults_are_deny_by_default_constants() {
  const v = machine().getSpoofedValues();
  Assert.equal(v.maxTouchPoints, 0, "mouse-only: no touch points");
  Assert.equal(v.touchEventsEnabled, false, "touch events denied");
  Assert.deepEqual(
    v.mediaDeviceCounts,
    { audioinput: 1, videoinput: 1, audiooutput: 1 },
    "one device of each kind, matching Gecko's fake backfill"
  );
  Assert.equal(v.streamVideoFacingMode, "", "facingMode hidden");
  Assert.equal(
    v.mediaCapabilities.powerEfficient,
    false,
    "media capabilities not power-efficient"
  );
  Assert.equal(
    v.mediaCapabilities.smooth,
    false,
    "media capabilities not smooth"
  );
  Assert.equal(v.gamepadsExposed, false, "gamepads blocked");
  Assert.equal(v.deviceSensorsExposed, false, "device sensors blocked");
  Assert.equal(v.pointer.primaryPointer, "fine", "desktop fine pointer");
  Assert.equal(v.pointer.primaryHover, true, "desktop hover capability");
  Assert.equal(v.pointer.anyPointer, "fine", "any-pointer fine");
  Assert.equal(v.pointer.anyHover, true, "any-hover on");
  Assert.equal(v.networkConnectionType, "unknown", "connection type unknown");
  Assert.equal(
    v.storageQuotaBytes,
    50 * 1024 * 1024 * 1024,
    "storage quota pinned to the spoofed 50 GiB"
  );
  Assert.equal(v.batteryExposed, false, "Battery API hidden");
});

add_task(function test_deterministic_prefs_hide_battery_by_default() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("dom.battery.enabled"),
    false,
    "Battery API hidden via dom.battery.enabled by default"
  );
});

add_task(function test_battery_pref_only_when_hidden() {
  // If a profile deliberately exposes the Battery API, we must not force the pref
  // off — leave it to the browser default so the override is honoured.
  const prefs = machine({ batteryExposed: true }).deterministicPrefs();
  Assert.ok(
    !prefs.has("dom.battery.enabled"),
    "no battery pref written when the profile exposes Battery"
  );
});

add_task(function test_overrides_are_never_folded_into_prefs() {
  // The overrides fragment must be merged with the rest of the profile overrides,
  // not written as a standalone pref that would clobber them.
  const prefs = machine().deterministicPrefs();
  Assert.ok(
    !prefs.has("privacy.fingerprintingProtection.overrides"),
    "deterministicPrefs does not write the overrides pref directly"
  );
});

add_task(function test_explicit_overrides_win_and_are_stable() {
  const profile = {
    maxTouchPoints: 5,
    touchEventsEnabled: true,
    mediaDeviceCounts: { videoinput: 2 },
    networkConnectionType: "wifi",
    primaryPointer: "coarse",
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-override profile is reproducible");
  Assert.equal(v1.maxTouchPoints, 5, "explicit maxTouchPoints wins");
  Assert.equal(v1.touchEventsEnabled, true, "explicit touch flag wins");
  Assert.deepEqual(
    v1.mediaDeviceCounts,
    { audioinput: 1, videoinput: 2, audiooutput: 1 },
    "partial device-count override merges over the default shape"
  );
  Assert.equal(v1.networkConnectionType, "wifi", "explicit connection wins");
  Assert.equal(v1.pointer.primaryPointer, "coarse", "explicit pointer wins");
  // Returned device counts are copies, not the frozen profile object.
  v1.mediaDeviceCounts.videoinput = 99;
  Assert.equal(
    machine(profile).getSpoofedValues().mediaDeviceCounts.videoinput,
    2,
    "getSpoofedValues returns a defensive copy of device counts"
  );
});

add_task(function test_fromProfile_threads_section6_fields_only() {
  const fp = new VentoFingerprintProfile({
    seed: "shared-vento-seed-6a1d",
    fields: { maxTouchPoints: 10, userAgent: "irrelevant" },
  });
  const input = VentoInputDevices.fromProfile(fp);
  Assert.equal(
    input.getSpoofedValues().maxTouchPoints,
    10,
    "section-6 field (maxTouchPoints) threaded from the profile"
  );
  // Non-section-6 fields are ignored; unspecified section-6 fields stay default.
  Assert.equal(
    input.getSpoofedValues().networkConnectionType,
    DEFAULT_INPUT_PROFILE.networkConnectionType,
    "unspecified section-6 fields keep the fleet-wide default"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => new VentoInputDevices({ maxTouchPoints: -1 }),
    /maxTouchPoints must be a non-negative integer/,
    "negative maxTouchPoints rejected"
  );
  Assert.throws(
    () => new VentoInputDevices({ mediaDeviceCounts: { videoinput: -1 } }),
    /mediaDeviceCounts.videoinput must be a non-negative integer/,
    "negative device count rejected"
  );
  Assert.throws(
    () => new VentoInputDevices({ storageQuotaBytes: 0 }),
    /storageQuotaBytes must be a positive integer/,
    "non-positive storage quota rejected"
  );
  Assert.throws(
    () => new VentoInputDevices({ primaryPointer: "bogus" }),
    /pointer capability must be one of/,
    "invalid pointer capability rejected"
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
  for (const target of SECTION6_TARGETS) {
    Assert.ok(
      covered.has(target),
      `injectionPoints() documents a hook for ${target}`
    );
  }
});

add_task(function test_residual_variance_is_optional_native_only() {
  const residual = machine().residualVariance();
  Assert.greater(residual.length, 0, "residual variance is enumerated");
  for (const item of residual) {
    Assert.ok(item.id, "residual item has an id");
    Assert.ok(
      item.injectionPoint,
      "residual item names a native injection point"
    );
    Assert.ok(
      item.normalisedBy.includes("needs nothing") ||
        item.normalisedBy.includes("optional"),
      `residual '${item.id}' is optional (default already deterministic)`
    );
  }
});
