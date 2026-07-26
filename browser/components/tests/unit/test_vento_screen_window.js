/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento screen / window / DPI / CSS-media surface tests (section 2 of
 * FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoScreenWindow built from the
 *     same profile ("two machines") return byte-for-byte identical spoofed
 *     values, prefs and descriptor;
 *   - the actual mitigation: every section-2 RFPTarget this module owns is
 *     present in the overrides fragment, and the defaults are the
 *     fingerprint-safe constants that enabling those targets produces (24bpp
 *     screen depth, srgb gamut, standard dynamic range, light/no-preference
 *     prefers-*, disabled site-specific zoom).
 */

"use strict";

const { VentoScreenWindow, SECTION2_TARGETS, DEFAULT_SCREENWINDOW_PROFILE } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoScreenWindow.sys.mjs"
  );
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

function machine(profile) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoScreenWindow(profile);
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-2 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-2 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-2 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section2_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION2_TARGETS.length,
    "one override token per section-2 target"
  );
  for (const target of SECTION2_TARGETS) {
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

add_task(function test_pointer_target_delegated_to_section6() {
  // CSSPointerCapabilities(58) is owned by the section-6 module, so this module
  // must NOT enable it (that would double-own the target). The pointer/hover
  // values are still mirrored in the reported shape.
  Assert.ok(
    !SECTION2_TARGETS.includes("CSSPointerCapabilities"),
    "CSSPointerCapabilities is not enabled here (owned by section 6)"
  );
  const m = machine().getSpoofedValues().cssMedia;
  Assert.equal(m.pointer, "fine", "pointer mirrored");
  Assert.equal(m.hover, "hover", "hover mirrored");
});

add_task(function test_defaults_are_fingerprint_safe_constants() {
  const v = machine().getSpoofedValues();
  Assert.equal(v.screen.colorDepth, 24, "color depth 24");
  Assert.equal(v.screen.pixelDepth, 24, "pixel depth 24");
  Assert.equal(
    v.screen.availWidth,
    v.screen.width,
    "availWidth == width (no work-area delta)"
  );
  Assert.equal(
    v.screen.availHeight,
    v.screen.height,
    "availHeight == height (no work-area delta)"
  );
  Assert.equal(v.devicePixelRatio, 1, "DPR pinned to 1");
  Assert.equal(v.cssMedia.colorGamut, "srgb", "color-gamut srgb");
  Assert.equal(v.cssMedia.dynamicRange, "standard", "dynamic-range standard");
  Assert.equal(
    v.cssMedia.videoDynamicRange,
    "standard",
    "video-dynamic-range standard"
  );
  Assert.equal(v.cssMedia.color, 8, "@media color 8 bits/component");
  Assert.equal(v.cssMedia.monochrome, 0, "@media monochrome 0");
  Assert.equal(v.cssMedia.resolution, 1, "@media resolution 1 dppx");
  Assert.equal(v.cssMedia.prefersColorScheme, "light", "prefers light");
  Assert.equal(
    v.cssMedia.prefersReducedMotion,
    "no-preference",
    "reduced-motion no-preference"
  );
  Assert.equal(
    v.cssMedia.prefersReducedTransparency,
    "no-preference",
    "reduced-transparency no-preference"
  );
  Assert.equal(
    v.cssMedia.prefersContrast,
    "no-preference",
    "contrast no-preference"
  );
  Assert.equal(v.cssMedia.invertedColors, "none", "inverted-colors none");
  Assert.equal(v.siteSpecificZoom, false, "site-specific zoom disabled");
  Assert.equal(v.zoom, 1, "full zoom pinned to 100%");
});

add_task(function test_deterministic_prefs_names_and_values() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("browser.zoom.siteSpecific"),
    false,
    "browser.zoom.siteSpecific pinned off"
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
    screenWidth: 2560,
    screenHeight: 1440,
    screenAvailWidth: 2560,
    screenAvailHeight: 1400,
    devicePixelRatio: 2,
    resolution: 2,
    colorGamut: "p3",
    prefersColorScheme: "dark",
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-override profile is reproducible");
  Assert.equal(v1.screen.width, 2560, "explicit screen width wins");
  Assert.equal(v1.screen.height, 1440, "explicit screen height wins");
  Assert.equal(v1.screen.availHeight, 1400, "explicit availHeight wins");
  Assert.equal(v1.devicePixelRatio, 2, "explicit DPR wins");
  Assert.equal(v1.cssMedia.resolution, 2, "explicit resolution wins");
  Assert.equal(v1.cssMedia.colorGamut, "p3", "explicit gamut wins");
  Assert.equal(v1.cssMedia.prefersColorScheme, "dark", "explicit scheme wins");
});

add_task(function test_fromProfile_threads_screen_fields() {
  const fp = new VentoFingerprintProfile({
    seed: "shared-vento-seed-2f9c",
    fields: {
      screen: { width: 1366, height: 768, colorDepth: 24 },
      devicePixelRatio: 1,
      userAgent: "irrelevant",
    },
  });
  const sw = VentoScreenWindow.fromProfile(fp);
  const v = sw.getSpoofedValues();
  Assert.equal(
    v.screen.width,
    1366,
    "screen width threaded from profile.screen"
  );
  Assert.equal(
    v.screen.height,
    768,
    "screen height threaded from profile.screen"
  );
  Assert.equal(
    v.cssMedia.deviceWidth,
    1366,
    "device-width threaded from profile.screen"
  );
  // Unspecified section-2 fields keep the fleet-wide default.
  Assert.equal(
    v.cssMedia.colorGamut,
    DEFAULT_SCREENWINDOW_PROFILE.colorGamut,
    "unspecified section-2 fields keep the fleet-wide default"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => new VentoScreenWindow({ screenWidth: 0 }),
    /screenWidth must be a positive integer/,
    "non-positive screen width rejected"
  );
  Assert.throws(
    () => new VentoScreenWindow({ devicePixelRatio: 0 }),
    /devicePixelRatio must be a positive number/,
    "non-positive DPR rejected"
  );
  Assert.throws(
    () => new VentoScreenWindow({ colorGamut: "srgb-plus" }),
    /colorGamut must be one of/,
    "unknown color-gamut rejected"
  );
  Assert.throws(
    () => new VentoScreenWindow({ screenAvailWidth: 4000 }),
    /available screen size cannot exceed the screen size/,
    "avail size larger than screen rejected"
  );
  Assert.throws(
    () => new VentoScreenWindow({ siteSpecificZoom: "no" }),
    /siteSpecificZoom must be a boolean/,
    "non-boolean siteSpecificZoom rejected"
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
  for (const target of SECTION2_TARGETS) {
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
