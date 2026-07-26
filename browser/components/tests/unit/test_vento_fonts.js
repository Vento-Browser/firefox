/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento fonts tests (section 4 of FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoFonts built from the same
 *     profile ("two machines") return byte-for-byte identical spoofed values,
 *     prefs and descriptor — including a stable font-list order regardless of the
 *     input order;
 *   - the actual mitigation: every section-4 RFPTarget is present in the overrides
 *     fragment, the visible tier is pinned to "base system fonts only", and the
 *     residual variance honestly flags the two things prefs cannot fix (the per-OS
 *     base set and glyph metrics).
 */

"use strict";

const {
  VentoFonts,
  SECTION4_TARGETS,
  DEFAULT_FONT_PROFILE,
  DEFAULT_FONTS,
  FONT_VISIBILITY,
} = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFonts.sys.mjs"
);
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

function machine(profile) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoFonts(profile);
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-4 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-4 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-4 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section4_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION4_TARGETS.length,
    "one override token per section-4 target"
  );
  for (const target of SECTION4_TARGETS) {
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

add_task(function test_defaults_clamp_to_base_system_tier() {
  const v = machine().getSpoofedValues();
  Assert.equal(
    v.fontVisibilityLevel,
    FONT_VISIBILITY.BASE,
    "visibility clamped to base-system tier (1)"
  );
  Assert.equal(v.useHardcodedFontSubstitutes, true, "hardcoded substitutes on");
  Assert.equal(v.restrictGenerics, true, "generics restricted");
  Assert.equal(v.osxFontSmoothingHidden, true, "osx font smoothing normalised");
  Assert.greater(
    v.fonts.length,
    0,
    "a non-empty fleet-wide font list is exposed"
  );
  Assert.deepEqual(
    machine().deterministicPrefs().get("layout.css.font-visibility"),
    FONT_VISIBILITY.BASE,
    "layout.css.font-visibility pinned to base tier"
  );
});

add_task(function test_font_list_is_normalised_and_stable() {
  // Same set of families in a shuffled, duplicated input must yield an identical
  // normalised list on any machine — that is the cross-machine list identity.
  const shuffled = {
    fonts: ["Verdana", "Arial", "arial", "Georgia", "Verdana", "Courier New"],
  };
  const a = machine(shuffled).getSpoofedValues().fonts;
  const b = machine(shuffled).getSpoofedValues().fonts;
  Assert.deepEqual(a, b, "normalised list reproducible");
  // De-duplicated (case-insensitive input keeps distinct casings but drops exact
  // dupes) and sorted.
  const sorted = a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  Assert.deepEqual(a, sorted, "font list is sorted");
  Assert.equal(
    a.filter(f => f === "Verdana").length,
    1,
    "exact duplicates removed"
  );
});

add_task(function test_overrides_are_never_folded_into_prefs() {
  const prefs = machine().deterministicPrefs();
  Assert.ok(
    !prefs.has("privacy.fingerprintingProtection.overrides"),
    "deterministicPrefs does not write the overrides pref directly"
  );
});

add_task(function test_explicit_whitelist_wins_and_is_stable() {
  const profile = {
    fonts: ["Helvetica", "Times New Roman", "Menlo"],
    osxFontSmoothingHidden: false,
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-whitelist profile is reproducible");
  Assert.deepEqual(
    v1.fonts,
    ["Helvetica", "Menlo", "Times New Roman"],
    "explicit whitelist wins and is normalised"
  );
  Assert.equal(
    v1.osxFontSmoothingHidden,
    false,
    "explicit smoothing flag wins"
  );
  // getSpoofedValues returns a copy; mutating it must not leak back.
  v1.fonts.push("mutated");
  Assert.equal(
    machine(profile).getSpoofedValues().fonts.length,
    3,
    "getSpoofedValues returns a defensive copy of the font list"
  );
});

add_task(function test_isFontVisible_reflects_whitelist() {
  const fonts = machine();
  Assert.ok(fonts.isFontVisible("Arial"), "whitelisted font visible");
  Assert.ok(fonts.isFontVisible("arial"), "visibility is case-insensitive");
  Assert.ok(
    !fonts.isFontVisible("Some User Installed Font"),
    "non-whitelisted font hidden"
  );
});

add_task(function test_default_list_matches_windows_persona() {
  // The default list is a Windows base subset, consistent with the Win32 persona
  // the rest of the default profile advertises.
  Assert.ok(
    DEFAULT_FONTS.includes("Segoe UI"),
    "default list carries a signature Windows family"
  );
  Assert.ok(
    !DEFAULT_FONTS.includes("Helvetica Neue"),
    "default list does not carry a macOS-only family"
  );
});

add_task(function test_fromProfile_threads_fonts_field() {
  const fp = new VentoFingerprintProfile({
    seed: "shared-vento-seed-4a1b",
    fields: { fonts: ["Arial", "Georgia"], userAgent: "irrelevant" },
  });
  const fonts = VentoFonts.fromProfile(fp);
  Assert.deepEqual(
    fonts.getSpoofedValues().fonts,
    ["Arial", "Georgia"],
    "font whitelist threaded from the profile"
  );
  // Non-section-4 fields are ignored; unspecified section-4 fields stay default.
  Assert.equal(
    fonts.getSpoofedValues().fontVisibilityLevel,
    DEFAULT_FONT_PROFILE.fontVisibilityLevel,
    "unspecified section-4 fields keep the fleet-wide default"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => new VentoFonts({ fonts: "not-an-array" }),
    /fonts must be an array/,
    "non-array font list rejected"
  );
  Assert.throws(
    () => new VentoFonts({ fonts: ["Arial", ""] }),
    /every font must be a non-empty string/,
    "empty font name rejected"
  );
  Assert.throws(
    () => new VentoFonts({ fontVisibilityLevel: 4 }),
    /fontVisibilityLevel must be 1, 2 or 3/,
    "out-of-range visibility level rejected"
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
  for (const target of SECTION4_TARGETS) {
    Assert.ok(
      covered.has(target),
      `injectionPoints() documents a hook for ${target}`
    );
  }
});

add_task(function test_residual_variance_flags_per_os_and_metrics() {
  const residual = machine().residualVariance();
  const ids = residual.map(r => r.id);
  Assert.ok(
    ids.includes("font-list-per-os-base-set"),
    "per-OS base-set divergence is flagged as a native remainder"
  );
  Assert.ok(
    ids.includes("glyph-render-metrics"),
    "glyph-metrics variance is flagged (ties to section 3)"
  );
  for (const item of residual) {
    Assert.ok(item.id, "residual item has an id");
    Assert.ok(
      item.injectionPoint,
      "residual item names a native injection point"
    );
  }
});
