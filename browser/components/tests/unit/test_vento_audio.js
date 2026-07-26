/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento audio (AudioContext) tests (section 5 of FINGERPRINTING_RESEARCH.md).
 *
 * Two things are checked:
 *   - determinism / identity: two independent VentoAudio built from the same
 *     profile ("two machines") return byte-for-byte identical spoofed values,
 *     prefs, descriptor and — for the optional DSP micro-noise — an identical
 *     seed-derived noise stream and perturbed buffer;
 *   - the actual mitigation: both section-5 RFPTargets are present in the
 *     overrides fragment, the defaults are the RFP build-constants (44100 Hz, 2
 *     channels, a single fleet-wide latency), and the DSP noise stays a bounded,
 *     opt-in, seed-gated stream.
 */

"use strict";

const {
  VentoAudio,
  SECTION5_TARGETS,
  DEFAULT_AUDIO_PROFILE,
  AUDIO_NOISE_AMPLITUDE,
} = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoAudio.sys.mjs"
);
const { VentoFingerprintProfile } = ChromeUtils.importESModule(
  "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs"
);

const SHARED_SEED = "shared-vento-seed-audio-4d2a";

function machine(profile = {}, seed = SHARED_SEED) {
  // A fresh instance stands in for a fresh profile on another computer.
  return new VentoAudio({ seed, profile });
}

add_task(function test_spoofed_values_identical_across_machines() {
  const m1 = machine();
  const m2 = machine();
  Assert.deepEqual(
    m1.getSpoofedValues(),
    m2.getSpoofedValues(),
    "section-5 spoofed values identical on two machines"
  );
  Assert.deepEqual(
    Array.from(m1.deterministicPrefs()),
    Array.from(m2.deterministicPrefs()),
    "section-5 prefs identical on two machines"
  );
  Assert.equal(
    m1.surfaceDescriptor(),
    m2.surfaceDescriptor(),
    "section-5 descriptor identical on two machines"
  );
});

add_task(function test_overrides_fragment_covers_every_section5_target() {
  const frag = machine().overridesFragment();
  const parts = frag.split(",");
  Assert.equal(
    parts.length,
    SECTION5_TARGETS.length,
    "one override token per section-5 target"
  );
  for (const target of SECTION5_TARGETS) {
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

add_task(function test_defaults_are_rfp_build_constants() {
  const v = machine().getSpoofedValues();
  Assert.equal(v.sampleRate, 44100, "AudioSampleRate build-constant (44100)");
  Assert.equal(v.maxChannelCount, 2, "maxChannelCount forced to 2");
  Assert.equal(v.baseLatency, 0.04, "baseLatency pinned fleet-wide");
  Assert.equal(v.outputLatency, 0.04, "outputLatency pinned fleet-wide");
  Assert.equal(
    DEFAULT_AUDIO_PROFILE.dspNoise,
    false,
    "DSP micro-noise off by default (targets alone are build-constant)"
  );
});

add_task(function test_deterministic_prefs_names_and_values() {
  const prefs = machine().deterministicPrefs();
  Assert.equal(
    prefs.get("media.cubeb.force_sample_rate"),
    44100,
    "cubeb sample rate hard-pinned to the profile sample rate"
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
    sampleRate: 48000,
    maxChannelCount: 6,
    outputLatency: 0.02,
    baseLatency: 0.02,
  };
  const v1 = machine(profile).getSpoofedValues();
  const v2 = machine(profile).getSpoofedValues();
  Assert.deepEqual(v1, v2, "explicit-override profile is reproducible");
  Assert.equal(v1.sampleRate, 48000, "explicit sampleRate wins");
  Assert.equal(v1.maxChannelCount, 6, "explicit maxChannelCount wins");
  Assert.equal(v1.outputLatency, 0.02, "explicit outputLatency wins");
  Assert.equal(
    machine(profile).deterministicPrefs().get("media.cubeb.force_sample_rate"),
    48000,
    "explicit sampleRate flows into media.cubeb.force_sample_rate"
  );
});

add_task(function test_fromProfile_threads_section5_fields_only() {
  const fp = new VentoFingerprintProfile({
    seed: SHARED_SEED,
    fields: { sampleRate: 96000, userAgent: "irrelevant" },
  });
  const audio = VentoAudio.fromProfile(fp);
  Assert.equal(
    audio.getSpoofedValues().sampleRate,
    96000,
    "section-5 field (sampleRate) threaded from the profile"
  );
  // Non-section-5 fields are ignored; unspecified section-5 fields stay default.
  Assert.equal(
    audio.getSpoofedValues().maxChannelCount,
    DEFAULT_AUDIO_PROFILE.maxChannelCount,
    "unspecified section-5 fields keep the fleet-wide default"
  );
  // The seed is threaded through so the DSP noise shares the master secret.
  Assert.equal(
    audio.seed,
    SHARED_SEED,
    "master seed threaded from the profile"
  );
});

add_task(function test_invalid_profiles_rejected() {
  Assert.throws(
    () => new VentoAudio({ profile: { sampleRate: 0 } }),
    /sampleRate must be a positive number/,
    "non-positive sampleRate rejected"
  );
  Assert.throws(
    () => new VentoAudio({ profile: { maxChannelCount: 2.5 } }),
    /maxChannelCount must be a positive integer/,
    "non-integer maxChannelCount rejected"
  );
  Assert.throws(
    () => new VentoAudio({ profile: { outputLatency: -1 } }),
    /outputLatency must be a non-negative number/,
    "negative outputLatency rejected"
  );
  Assert.throws(
    () => new VentoAudio({ seed: "", profile: { dspNoise: true } }),
    /dspNoise requires a non-empty seed/,
    "dspNoise without a seed rejected"
  );
});

add_task(function test_audio_noise_is_deterministic_and_bounded() {
  const n1 = machine().audioNoise(256, "https://example.com");
  const n2 = machine().audioNoise(256, "https://example.com");
  Assert.equal(n1.length, 256, "noise stream has the requested length");
  Assert.deepEqual(
    Array.from(n1),
    Array.from(n2),
    "same (seed, origin) yields byte-identical noise on two machines"
  );
  for (let i = 0; i < n1.length; i++) {
    Assert.lessOrEqual(
      Math.abs(n1[i]),
      AUDIO_NOISE_AMPLITUDE,
      `sample ${i} stays within the sub-audible amplitude`
    );
  }
  // Different origins must not collide.
  const other = machine().audioNoise(256, "https://other.example");
  Assert.notDeepEqual(
    Array.from(n1),
    Array.from(other),
    "different origins get a different noise stream"
  );
});

add_task(function test_perturb_samples_matches_across_machines() {
  const samples = new Float64Array(64);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(i / 5);
  }
  const p1 = machine().perturbSamples(samples, "https://example.com");
  const p2 = machine().perturbSamples(samples, "https://example.com");
  Assert.deepEqual(
    Array.from(p1),
    Array.from(p2),
    "two machines perturb an identical buffer identically"
  );
  // Perturbation is exactly the noise stream added on top of the input.
  const noise = machine().audioNoise(samples.length, "https://example.com");
  for (let i = 0; i < samples.length; i++) {
    Assert.equal(
      p1[i],
      samples[i] + noise[i],
      `perturbed sample ${i} == input + noise`
    );
  }
});

add_task(function test_noise_requires_seed() {
  const noSeed = new VentoAudio({ seed: "", profile: {} });
  Assert.throws(
    () => noSeed.audioNoise(16),
    /noiseRng requires a non-empty seed/,
    "audio noise cannot be derived without a seed"
  );
  Assert.throws(
    () => noSeed.audioNoise(-1),
    /length must be a non-negative integer/,
    "negative noise length rejected"
  );
});

add_task(function test_injection_points_cover_every_target() {
  const points = machine().injectionPoints();
  const covered = new Set(points.map(pt => pt.target));
  for (const target of SECTION5_TARGETS) {
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
});
