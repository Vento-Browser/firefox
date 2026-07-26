/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento misc web-API surfaces tests (section 8 of FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoMiscSurfaces built from the
 *     same profile ("two machines") return byte-for-byte identical spoofed
 *     values, prefs and descriptor;
 *   - the actual mitigation: every section-8 RFPTarget is present in the
 *     overrides fragment, and the defaults are the deny-by-default constants that
 *     enabling those targets produces (empty voices, zeroed frame counters,
 *     hidden WebVTT/IME, blank MediaError, stand-in colors, fixed refresh rate).
 */

"use strict";

const { VentoMiscSurfaces, SECTION8_TARGETS, DEFAULT_MISC_PROFILE } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoMiscSurfaces.sys.mjs"
  );
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

function machine(profile) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoMiscSurfaces(profile);
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-8 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-8 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-8 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section8_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION8_TARGETS.length,
    "one override token per section-8 target"
  );
  for (const target of SECTION8_TARGETS) {
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
  Assert.deepEqual(v.speechVoices, [], "default voice list is empty (denied)");
  Assert.equal(
    v.screenOrientation.type,
    "landscape-primary",
    "orientation pinned"
  );
  Assert.equal(v.screenOrientation.angle, 0, "orientation angle pinned to 0");
  for (const key of Object.keys(v.videoMozFrames)) {
    Assert.equal(v.videoMozFrames[key], 0, `${key} zeroed`);
  }
  Assert.equal(
    v.videoPlaybackQuality.totalVideoFrames,
    0,
    "video quality zeroed"
  );
  Assert.equal(v.videoPlaybackQuality.droppedVideoFrames, 0, "dropped zeroed");
  Assert.equal(
    v.videoPlaybackQuality.corruptedVideoFrames,
    0,
    "corrupted zeroed"
  );
  Assert.equal(v.webvttExposed, false, "WebVTT hidden");
  Assert.equal(v.imeStyleHidden, true, "IME style hidden");
  Assert.equal(v.mediaErrorMessage, "", "MediaError message blanked");
  Assert.equal(v.useStandinsForNativeColors, true, "stand-in colors on");
  Assert.equal(v.frameRate, 60, "refresh rate fixed to 60");
});

add_task(function test_deterministic_prefs_names_and_values() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("layout.frame_rate"),
    60,
    "layout.frame_rate pinned to profile refresh rate"
  );
  Assert.equal(
    prefs.get("ui.use_standins_for_native_colors"),
    true,
    "stand-in colors pref pinned on"
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
    frameRate: 120,
    screenOrientationType: "portrait-primary",
    mediaErrorMessage: "unified",
    speechVoices: [
      { name: "Vento Voice", lang: "en-US", default: true, localService: true },
    ],
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-override profile is reproducible");
  Assert.equal(v1.frameRate, 120, "explicit frameRate wins");
  Assert.equal(
    machine(profile).deterministicPrefs().get("layout.frame_rate"),
    120,
    "explicit frameRate flows into layout.frame_rate"
  );
  Assert.equal(v1.screenOrientation.type, "portrait-primary", "orient wins");
  Assert.equal(v1.mediaErrorMessage, "unified", "explicit message wins");
  Assert.equal(v1.speechVoices.length, 1, "explicit voice list wins");
  // Returned voices are copies, not the caller's frozen array elements.
  v1.speechVoices[0].name = "mutated";
  Assert.equal(
    machine(profile).getSpoofedValues().speechVoices[0].name,
    "Vento Voice",
    "getSpoofedValues returns defensive copies of voices"
  );
});

add_task(function test_fromProfile_threads_section8_fields_only() {
  const fp = new VentoFingerprintProfile({
    seed: "shared-vento-seed-2f9c",
    fields: { frameRate: 90, userAgent: "irrelevant" },
  });
  const misc = VentoMiscSurfaces.fromProfile(fp);
  Assert.equal(
    misc.getSpoofedValues().frameRate,
    90,
    "section-8 field (frameRate) threaded from the profile"
  );
  // Non-section-8 fields are ignored; unspecified section-8 fields stay default.
  Assert.equal(
    misc.getSpoofedValues().screenOrientation.type,
    DEFAULT_MISC_PROFILE.screenOrientationType,
    "unspecified section-8 fields keep the fleet-wide default"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => new VentoMiscSurfaces({ frameRate: 0 }),
    /frameRate must be a positive number/,
    "non-positive frameRate rejected"
  );
  Assert.throws(
    () => new VentoMiscSurfaces({ speechVoices: "not-an-array" }),
    /speechVoices must be an array/,
    "non-array voice list rejected"
  );
  Assert.throws(
    () => new VentoMiscSurfaces({ mediaErrorMessage: 42 }),
    /mediaErrorMessage must be a string/,
    "non-string MediaError message rejected"
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
  for (const target of SECTION8_TARGETS) {
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
