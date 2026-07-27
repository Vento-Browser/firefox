/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento fingerprint composer / deny-by-default coverage tests.
 *
 * The composer is the top-level foundation piece: it turns one profile into one
 * applied configuration and enforces the "deny by default" checklist — every
 * surface-bearing RFPTarget (RFPTargets.inc, ids 1..81) must be either pinned to
 * the profile by a channel or given an explicit composer disposition. These tests
 * assert that the checklist is complete (no holes), that the merged overrides
 * string and pref map are deterministic (identical across "two machines"), and
 * that the format is versioned/migratable.
 */

"use strict";

const { VentoFingerprintComposer, ALL_RFP_TARGETS, COMPOSER_DISPOSITIONS } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoFingerprintComposer.sys.mjs"
  );
const { VentoFingerprintProfile, PROFILE_FORMAT_VERSION } =
  ChromeUtils.importESModule(
    "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
  );

const SEED = "shared-vento-seed-composer";

function machine(seed = SEED, fields) {
  return new VentoFingerprintProfile({ seed, fields });
}

add_task(function test_checklist_has_exactly_81_surface_targets() {
  Assert.equal(
    ALL_RFP_TARGETS.length,
    81,
    "the checklist mirrors RFPTargets.inc surface targets (ids 1..81)"
  );
  Assert.equal(
    new Set(ALL_RFP_TARGETS).size,
    81,
    "no duplicate target names in the checklist"
  );
});

add_task(function test_every_target_has_a_disposition() {
  const report = VentoFingerprintComposer.assertFullCoverage();
  Assert.equal(report.missing.length, 0, "no coverage holes");
  const covered =
    report.pinned.length +
    report.enabled.length +
    report.blocked.length +
    report.policy.length;
  Assert.equal(
    covered,
    81,
    "every one of the 81 targets is pinned/enabled/blocked/policy"
  );
});

add_task(function test_dispositions_are_disjoint_from_channels() {
  // coverageReport() throws if a target is both channel-pinned and dispositioned,
  // or if a disposition names an unknown target — so a clean run proves both.
  const report = VentoFingerprintComposer.coverageReport();
  for (const t of Object.keys(COMPOSER_DISPOSITIONS)) {
    Assert.ok(
      !report.pinned.includes(t),
      `${t} is composer-dispositioned, not channel-pinned`
    );
  }
});

add_task(function test_randomizing_strategies_are_force_blocked() {
  // The identity guarantee dies if any per-machine-random surface is enabled, so
  // the vendor-randomize strategy MUST be explicitly force-disabled.
  const overrides = VentoFingerprintComposer.composeOverrides(machine());
  Assert.ok(
    overrides.includes("-WebGLVendorRandomize"),
    "WebGLVendorRandomize is force-disabled in the overrides string"
  );
  Assert.ok(
    overrides.includes("-WebGLVendorSanitize"),
    "WebGLVendorSanitize is force-disabled in the overrides string"
  );
  Assert.ok(
    !/\+WebGLVendorRandomize/.test(overrides),
    "WebGLVendorRandomize is never enabled"
  );
});

add_task(function test_overrides_string_identical_across_machines() {
  const a = VentoFingerprintComposer.composeOverrides(machine());
  const b = VentoFingerprintComposer.composeOverrides(machine());
  Assert.equal(
    a,
    b,
    "two machines with the same profile compose the same string"
  );
  Assert.ok(a.length, "the overrides string is non-empty");
  // Sorted output: assert it is actually sorted so review diffs stay stable.
  const tokens = a.split(",");
  const sorted = [...tokens].sort();
  Assert.deepEqual(tokens, sorted, "overrides tokens are sorted");
});

add_task(function test_prefs_identical_across_machines_and_master_set() {
  const a = VentoFingerprintComposer.composePrefs(machine());
  const b = VentoFingerprintComposer.composePrefs(machine());
  Assert.deepEqual(
    [...a.entries()].sort(),
    [...b.entries()].sort(),
    "composed pref map is identical on two machines"
  );
  Assert.strictEqual(
    a.get("privacy.fingerprintingProtection"),
    true,
    "master fingerprintingProtection toggle is on"
  );
  Assert.equal(
    a.get("vento.fingerprint.seed"),
    SEED,
    "the deterministic-seed pref carries the profile seed"
  );
  Assert.equal(
    a.get("privacy.fingerprintingProtection.overrides"),
    VentoFingerprintComposer.composeOverrides(machine()),
    "the overrides pref equals the composed overrides string"
  );
});

add_task(function test_no_pref_key_collision_across_channels() {
  // composePrefs throws on a conflicting pref value across channels; a clean
  // return proves the channels do not fight over a pref key.
  const prefs = VentoFingerprintComposer.composePrefs(machine());
  Assert.greater(
    prefs.size,
    3,
    "channels contributed their own value prefs too"
  );
});

add_task(function test_profile_format_is_versioned() {
  const exported = machine(SEED, { platform: "Linux x86_64" }).export();
  Assert.equal(
    exported.version,
    PROFILE_FORMAT_VERSION,
    "export() stamps the current format version"
  );
  Assert.ok(
    "seed" in exported && "fields" in exported,
    "export shape is stable"
  );
});

add_task(function test_legacy_versionless_payload_migrates() {
  // A pre-versioning payload (no `version`) must import as the current format.
  const legacy = { seed: SEED, fields: { platform: "Win32" } };
  const restored = VentoFingerprintProfile.import(legacy);
  Assert.equal(
    restored.version,
    PROFILE_FORMAT_VERSION,
    "a versionless payload is migrated to the current version"
  );
  Assert.equal(restored.seed, SEED, "seed survives migration");
});

add_task(function test_future_version_is_rejected() {
  Assert.throws(
    () =>
      VentoFingerprintProfile.import({
        version: PROFILE_FORMAT_VERSION + 99,
        seed: SEED,
      }),
    /newer than this build supports/,
    "a payload from a newer browser is refused, not misread"
  );
});
