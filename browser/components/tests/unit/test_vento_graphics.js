/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento graphics (Canvas / WebGL / WebGPU / WebCodecs) tests — section 3 of
 * FINGERPRINTING_RESEARCH.md, the "fattest" entropy channel.
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoGraphics built from the same
 *     profile ("two machines") return byte-for-byte identical spoofed values,
 *     prefs, descriptor, readback seed keys and readback noise streams;
 *   - the actual mitigation: every section-3 RFPTarget is enabled in the
 *     overrides fragment, the UNMASKED vendor/renderer are pinned via prefs, the
 *     strategy verdict forces route (b) software render for readback, and the
 *     readback noise is a bounded, seed-gated integer stream.
 */

"use strict";

const {
  VentoGraphics,
  SECTION3_TARGETS,
  DEFAULT_GRAPHICS_PROFILE,
  CANVAS_NOISE_AMPLITUDE,
} = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoGraphics.sys.mjs"
);
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

const SHARED_SEED = "shared-vento-seed-graphics-9f31";

function machine(profile = {}, seed = SHARED_SEED) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoGraphics({ seed, profile });
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-3 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-3 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-3 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section3_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION3_TARGETS.length,
    "one override token per section-3 target"
  );
  for (const target of SECTION3_TARGETS) {
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

add_task(function test_deterministic_prefs_pin_vendor_renderer_and_software() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("webgl.override-unmasked-vendor"),
    DEFAULT_GRAPHICS_PROFILE.unmaskedVendor,
    "UNMASKED vendor pinned fleet-wide"
  );
  Assert.equal(
    prefs.get("webgl.override-unmasked-renderer"),
    DEFAULT_GRAPHICS_PROFILE.unmaskedRenderer,
    "UNMASKED renderer pinned fleet-wide"
  );
  // Strategy verdict route (b): readback forced to a software render.
  Assert.strictEqual(
    prefs.get("gfx.canvas.accelerated"),
    false,
    "software canvas 2D forced"
  );
  Assert.strictEqual(
    prefs.get("webgl.forbid-hardware"),
    true,
    "hardware WebGL forbidden"
  );
  Assert.strictEqual(
    prefs.get("gfx.webrender.software"),
    true,
    "WebRender forced to software"
  );
});

add_task(function test_software_render_prefs_absent_when_disabled() {
  const prefs = machine({ softwareRender: false }).deterministicPrefs();
  Assert.ok(
    prefs.has("webgl.override-unmasked-vendor"),
    "vendor pref stays even with software render off"
  );
  Assert.ok(
    !prefs.has("gfx.canvas.accelerated"),
    "no software-canvas pin when softwareRender is off"
  );
  Assert.ok(
    !prefs.has("webgl.forbid-hardware"),
    "no hardware-forbid pin when softwareRender is off"
  );
});

add_task(function test_overrides_are_never_folded_into_prefs() {
  const prefs = machine().deterministicPrefs();
  Assert.ok(
    !prefs.has("privacy.fingerprintingProtection.overrides"),
    "deterministicPrefs does not write the overrides pref directly"
  );
});

add_task(function test_defaults_encode_the_strategy_verdict() {
  Assert.strictEqual(
    DEFAULT_GRAPHICS_PROFILE.softwareRender,
    true,
    "route (b) software render is the fleet default"
  );
  Assert.strictEqual(
    DEFAULT_GRAPHICS_PROFILE.deterministicNoise,
    true,
    "deterministic readback noise key is the fleet default"
  );
  const verdict = machine().strategyVerdict();
  Assert.equal(
    verdict.chosen,
    "b-for-readback-plus-deterministic-seed",
    "verdict is route (b) for readback plus the deterministic seed"
  );
  Assert.ok(verdict.routes.a && verdict.routes.b, "both routes documented");
  Assert.ok(verdict.rationale.length, "verdict carries a rationale");
});

add_task(function test_readback_seed_keys_identical_and_distinct() {
  const origin = "https://example.com";
  Assert.equal(
    machine().canvasSeedHex(origin),
    machine().canvasSeedHex(origin),
    "canvas readback key identical on two machines"
  );
  Assert.equal(
    machine().webglSeedHex(origin),
    machine().webglSeedHex(origin),
    "webgl readback key identical on two machines"
  );
  // Canvas and WebGL surfaces must not share a key, and origins must not collide.
  Assert.notEqual(
    machine().canvasSeedHex(origin),
    machine().webglSeedHex(origin),
    "canvas and webgl keys differ for the same origin"
  );
  Assert.notEqual(
    machine().canvasSeedHex(origin),
    machine().canvasSeedHex("https://other.example"),
    "different origins get different canvas keys"
  );
});

add_task(function test_readback_noise_is_deterministic_and_bounded() {
  const origin = "https://example.com";
  const n1 = machine().canvasNoise(256, origin);
  const n2 = machine().canvasNoise(256, origin);
  Assert.equal(n1.length, 256, "noise stream has the requested length");
  Assert.deepEqual(
    Array.from(n1),
    Array.from(n2),
    "same (seed, origin) yields byte-identical canvas noise on two machines"
  );
  for (let i = 0; i < n1.length; i++) {
    Assert.lessOrEqual(
      Math.abs(n1[i]),
      CANVAS_NOISE_AMPLITUDE,
      `channel ${i} stays within the noise amplitude`
    );
  }
  // Canvas and WebGL noise streams must differ for the same origin.
  Assert.notDeepEqual(
    Array.from(machine().canvasNoise(256, origin)),
    Array.from(machine().webglNoise(256, origin)),
    "canvas and webgl noise streams differ"
  );
});

add_task(function test_perturb_pixels_matches_across_machines() {
  const bytes = new Uint8ClampedArray(64);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 7) % 256;
  }
  const origin = "https://example.com";
  const p1 = machine().perturbPixels(bytes, "canvas", origin);
  const p2 = machine().perturbPixels(bytes, "canvas", origin);
  Assert.deepEqual(
    Array.from(p1),
    Array.from(p2),
    "two machines perturb an identical pixel buffer identically"
  );
  // Perturbation is the noise stream added on top, clamped to [0,255].
  const noise = machine().canvasNoise(bytes.length, origin);
  for (let i = 0; i < bytes.length; i++) {
    Assert.equal(
      p1[i],
      Math.max(0, Math.min(255, bytes[i] + noise[i])),
      `perturbed channel ${i} == clamp(input + noise)`
    );
  }
});

add_task(function test_fromProfile_threads_gpu_identity() {
  const fp = new VentoFingerprintProfile({
    seed: SHARED_SEED,
    fields: {
      gpuVendor: "Google Inc. (NVIDIA)",
      gpuRenderer:
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      userAgent: "irrelevant",
    },
  });
  const gfx = VentoGraphics.fromProfile(fp);
  Assert.equal(
    gfx.getSpoofedValues().unmaskedVendor,
    "Google Inc. (NVIDIA)",
    "profile gpuVendor maps onto UNMASKED vendor"
  );
  Assert.equal(
    gfx.getSpoofedValues().unmaskedRenderer,
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "profile gpuRenderer maps onto UNMASKED renderer"
  );
  Assert.equal(gfx.seed, SHARED_SEED, "master seed threaded from the profile");
});

add_task(function test_explicit_overrides_win_and_are_stable() {
  const profile = {
    unmaskedVendor: "Apple",
    unmaskedRenderer: "Apple M2",
    softwareRender: false,
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-override profile is reproducible");
  Assert.equal(v1.unmaskedVendor, "Apple", "explicit vendor wins");
  Assert.equal(v1.unmaskedRenderer, "Apple M2", "explicit renderer wins");
  Assert.equal(v1.softwareRender, false, "explicit softwareRender wins");
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () =>
      new VentoGraphics({ seed: SHARED_SEED, profile: { unmaskedVendor: "" } }),
    /unmaskedVendor must be a non-empty string/,
    "empty unmaskedVendor rejected"
  );
  Assert.throws(
    () =>
      new VentoGraphics({
        seed: SHARED_SEED,
        profile: { unmaskedRenderer: "" },
      }),
    /unmaskedRenderer must be a non-empty string/,
    "empty unmaskedRenderer rejected"
  );
  Assert.throws(
    () =>
      new VentoGraphics({ seed: "", profile: { deterministicNoise: true } }),
    /deterministicNoise requires a non-empty seed/,
    "deterministicNoise without a seed rejected"
  );
});

add_task(function test_noise_requires_seed() {
  const noSeed = new VentoGraphics({
    seed: "",
    profile: { deterministicNoise: false },
  });
  Assert.throws(
    () => noSeed.canvasNoise(16),
    /noiseRng requires a non-empty seed/,
    "readback noise cannot be derived without a seed"
  );
  Assert.throws(
    () => machine().canvasNoise(-1),
    /length must be a non-negative integer/,
    "negative noise length rejected"
  );
});

add_task(function test_injection_points_cover_every_target() {
  const points = machine().injectionPoints();
  const covered = new Set(points.flatMap(pt => pt.targets));
  for (const target of SECTION3_TARGETS) {
    Assert.ok(
      covered.has(target),
      `injectionPoints() documents a hook for ${target}`
    );
  }
  // The one core patch (the readback noise key) must be called out explicitly.
  Assert.ok(
    points.some(pt => pt.injectionPoint.includes("GetBrowsingSessionKey")),
    "the GetBrowsingSessionKey seed patch is documented as the core hook"
  );
});

add_task(function test_residual_variance_is_optional_native_only() {
  const residual = machine().residualVariance();
  Assert.greater(residual.length, 0, "residual variance is enumerated");
  for (const item of residual) {
    Assert.ok(item.id, "residual item has an id");
    Assert.ok(item.channel, "residual item names a channel");
    Assert.ok(
      item.injectionPoint,
      "residual item names a native injection point"
    );
    Assert.ok(
      item.normalisedBy,
      `residual '${item.id}' documents how it is normalised`
    );
  }
  // The readback base-render divergence is the crux and must be listed.
  Assert.ok(
    residual.some(r => r.id === "readback-base-render-divergence"),
    "the readback base-render divergence is enumerated"
  );
});
