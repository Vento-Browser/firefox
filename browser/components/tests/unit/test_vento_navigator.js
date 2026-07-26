/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento navigator + HTTP client-hints tests (section 1 of
 * FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoNavigator built from the same
 *     profile ("two machines") return byte-for-byte identical spoofed values,
 *     prefs and descriptor;
 *   - the actual mitigation: the fleet-wide value is pinned via the
 *     `general.*.override` prefs (the cross-OS path stock RFP cannot take), the
 *     defaults mirror what RFP / Firefox already expose, and — the section-1
 *     mandate — the whole navigator surface is internally CONSISTENT (UA vs
 *     platform vs oscpu vs UA-CH cannot contradict).
 */

"use strict";

const {
  VentoNavigator,
  SECTION1_TARGETS,
  DEFAULT_NAVIGATOR_PROFILE,
  OS_DESCRIPTORS,
} = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoNavigator.sys.mjs"
);
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

function machine(profile) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoNavigator(profile);
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-1 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-1 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-1 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section1_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION1_TARGETS.length,
    "one override token per section-1 target"
  );
  for (const target of SECTION1_TARGETS) {
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

add_task(function test_defaults_mirror_rfp_windows_surface() {
  const v = machine().getSpoofedValues();
  Assert.equal(
    v.userAgent,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "default UA is the fleet Windows/Firefox string"
  );
  Assert.equal(v.platform, "Win32", "default platform Win32");
  Assert.equal(v.oscpu, "Windows NT 10.0; Win64; x64", "default oscpu");
  Assert.equal(v.appVersion, "5.0 (Windows)", "default appVersion");
  Assert.equal(
    v.buildID,
    "20181001000000",
    "buildID is the RFP legacy constant"
  );
  Assert.equal(v.product, "Gecko", "product is Gecko");
  Assert.equal(v.productSub, "20100101", "productSub is the gecko trail");
  Assert.equal(v.hardwareConcurrency, 4, "hardwareConcurrency is the RFP 4");
  Assert.equal(v.language, "en-US", "default language en-US (matches RFP)");
  Assert.deepEqual(v.languages, ["en-US", "en"], "default languages");
  Assert.equal(v.pdfViewerEnabled, true, "pdf viewer enabled");
  Assert.equal(v.plugins.length, 5, "the fixed 5-entry PDF plugin shape");
  Assert.equal(v.deviceMemory, null, "deviceMemory not exposed (Firefox)");
});

add_task(function test_deterministic_prefs_pin_the_override_values() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("general.useragent.override"),
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "UA override pref carries the fleet UA"
  );
  Assert.equal(
    prefs.get("general.platform.override"),
    "Win32",
    "platform override pref"
  );
  Assert.equal(
    prefs.get("general.oscpu.override"),
    "Windows NT 10.0; Win64; x64",
    "oscpu override pref"
  );
  Assert.equal(
    prefs.get("general.appversion.override"),
    "5.0 (Windows)",
    "appversion override pref"
  );
  Assert.equal(
    prefs.get("general.buildID.override"),
    "20181001000000",
    "buildID override pref"
  );
  Assert.equal(
    prefs.get("intl.accept_languages"),
    "en-US,en;q=0.5",
    "accept_languages pref"
  );
  Assert.equal(
    prefs.get("dom.maxHardwareConcurrency"),
    4,
    "hardwareConcurrency clamp pref"
  );
  Assert.equal(prefs.get("pdfjs.disabled"), false, "pdfjs stays enabled");
});

add_task(function test_overrides_are_never_folded_into_prefs() {
  const prefs = machine().deterministicPrefs();
  Assert.ok(
    !prefs.has("privacy.fingerprintingProtection.overrides"),
    "deterministicPrefs does not write the overrides pref directly"
  );
});

add_task(function test_navigator_surface_is_internally_consistent() {
  for (const os of Object.keys(OS_DESCRIPTORS)) {
    const report = machine({ os }).consistency();
    Assert.ok(
      report.consistent,
      `os=${os} navigator surface is consistent (${report.mismatches.join("; ")})`
    );
  }
});

add_task(function test_each_os_descriptor_is_coherent_and_stable() {
  for (const os of Object.keys(OS_DESCRIPTORS)) {
    const v1 = machine({ os }).getSpoofedValues();
    const v2 = machine({ os }).getSpoofedValues();
    Assert.deepEqual(v1, v2, `os=${os} is reproducible across machines`);
    Assert.ok(
      v1.userAgent.includes(OS_DESCRIPTORS[os].uaOS),
      `os=${os} UA carries its os fragment`
    );
    Assert.equal(
      v1.platform,
      OS_DESCRIPTORS[os].platform,
      `os=${os} platform matches descriptor`
    );
  }
});

add_task(function test_inconsistent_explicit_ua_is_detected() {
  // A caller who force-sets a mac UA on a windows profile must be flagged: the
  // whole point of section 1 is that contradictions are themselves a fingerprint.
  const nav = machine({
    os: "windows",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
  });
  const report = nav.consistency();
  Assert.ok(!report.consistent, "mismatched explicit UA is flagged");
  Assert.greater(report.mismatches.length, 0, "at least one mismatch listed");
});

add_task(function test_accept_language_tracks_languages() {
  const nav = machine({ language: "de-DE", languages: ["de-DE", "de", "en"] });
  const v = nav.getSpoofedValues();
  Assert.equal(v.language, "de-DE", "primary language overridden");
  Assert.equal(
    v.acceptLanguage,
    "de-DE,de;q=0.9,en;q=0.8",
    "acceptLanguage derived from languages with descending q-weights"
  );
  Assert.ok(
    nav.consistency().consistent,
    "custom-locale surface stays consistent"
  );
});

add_task(function test_client_hints_are_derived_and_consistent() {
  const ch = machine().clientHints();
  Assert.equal(ch.platform, "Windows", "UA-CH platform matches os");
  Assert.equal(ch.mobile, false, "desktop UA-CH");
  Assert.ok(
    ch.brands.some(b => b.brand === "Firefox" && b.version === "128"),
    "UA-CH brands carry the Firefox major version consistent with the UA"
  );
  const macCh = machine({ os: "macos" }).clientHints();
  Assert.equal(macCh.platform, "macOS", "mac UA-CH platform");
});

add_task(function test_explicit_overrides_win_and_are_stable() {
  const profile = {
    os: "linux",
    hardwareConcurrency: 8,
    firefoxVersion: "130.0",
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-override profile is reproducible");
  Assert.equal(v1.platform, "Linux x86_64", "explicit os wins");
  Assert.equal(v1.hardwareConcurrency, 8, "explicit hw wins");
  Assert.ok(
    v1.userAgent.includes("Firefox/130.0"),
    "explicit firefoxVersion flows into the UA"
  );
  Assert.equal(
    machine(profile).deterministicPrefs().get("dom.maxHardwareConcurrency"),
    8,
    "explicit hw flows into the clamp pref"
  );
});

add_task(function test_fromProfile_threads_section1_fields_only() {
  const fp = new VentoFingerprintProfile({
    seed: "shared-vento-seed-1a2b",
    fields: { os: "macos", gpuVendor: "irrelevant" },
  });
  const nav = VentoNavigator.fromProfile(fp);
  Assert.equal(
    nav.getSpoofedValues().platform,
    "MacIntel",
    "section-1 field (os) threaded from the profile"
  );
  Assert.equal(
    nav.getSpoofedValues().language,
    DEFAULT_NAVIGATOR_PROFILE.language,
    "unspecified section-1 fields keep the fleet-wide default"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => new VentoNavigator({ os: "solaris" }),
    /unknown os/,
    "unknown os rejected"
  );
  Assert.throws(
    () => new VentoNavigator({ hardwareConcurrency: 0 }),
    /hardwareConcurrency must be a positive integer/,
    "non-positive hardwareConcurrency rejected"
  );
  Assert.throws(
    () => new VentoNavigator({ languages: [] }),
    /languages must be a non-empty array/,
    "empty languages rejected"
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
  for (const target of SECTION1_TARGETS) {
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
        item.normalisedBy.includes("Optional") ||
        item.normalisedBy.includes("optional"),
      `residual '${item.id}' is optional (default already deterministic)`
    );
  }
});
