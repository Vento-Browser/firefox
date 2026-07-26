/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Audio (AudioContext) — the isolated, engine-agnostic core of section 5
 * ("Аудио / AudioContext") of FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data + a deterministic PRNG: a
 * (partial) profile in, a set of spoofed audio parameters + an optional
 * seed-derived micro-noise stream out.
 *
 * The audio channel has TWO distinct sub-surfaces, with very different cost:
 *
 *   1. AUDIO PARAMETERS (low complexity, high testability). The static numbers a
 *      site reads off an AudioContext: `sampleRate`, `destination.maxChannelCount`,
 *      `baseLatency`/`outputLatency`. Two RFPTargets already cover these:
 *
 *        AudioSampleRate (39)  -> CubebUtils::PreferredSampleRate returns 44100
 *                                 when RFP is active (dom/media/CubebUtils.cpp).
 *        AudioContext (49)     -> AudioContext::MaxChannelCount() returns 2 and
 *                                 AudioContext::OutputLatency() returns a fixed,
 *                                 per-OS-plausible latency when RFP is active
 *                                 (dom/media/webaudio/AudioContext.cpp).
 *
 *      So — exactly like sections 6 and 8 — the parameters are closed by ENABLING
 *      the two targets via `privacy.fingerprintingProtection.overrides`, no native
 *      patch of their own. `overridesFragment()` emits that fragment.
 *
 *      ONE honest caveat (enumerated in `residualVariance()`): the RFP latency
 *      constant is OS-dependent (mac = 512/sampleRate, win = 0.04, android = 0.02,
 *      other = 0.025). That is build-constant per OS but NOT identical across
 *      OSes, so a Windows Vento and a macOS Vento with the same profile still
 *      differ on `baseLatency`. Pinning a single fleet-wide latency needs a
 *      one-line native swap in AudioContext::OutputLatency() (return
 *      `getSpoofedValues().outputLatency`); the default here is that pinned value.
 *
 *   2. AUDIO DSP HASH (high complexity, medium testability). The classic
 *      AudioContext fingerprint: render an OfflineAudioContext (oscillator ->
 *      DynamicsCompressor) and hash the float samples. KEY FINDING (verified
 *      against the tree): Gecko does NOT add RFP noise to WebAudio buffers (unlike
 *      canvas/WebGL). The DSP is pure software — the DynamicsCompressor and the
 *      ffvpx FFT (dom/media/webaudio/FFTBlock.h includes "ffvpx/tx.h") are
 *      compiled into the browser — so two Vento machines running the SAME build
 *      on the SAME CPU SIMD tier already produce byte-identical output. The only
 *      residual is cross-CPU SIMD divergence in ffvpx's av_tx (SSE/AVX/NEON
 *      choose different kernels at runtime, which can differ in the low float
 *      bits). Closing that last bit is optional and has two routes, both
 *      enumerated in `residualVariance()`: force the scalar FFT kernel, or apply a
 *      deterministic seed-derived micro-noise to the rendered buffer (analogous to
 *      canvas). This module ships the reference for the second route:
 *      `audioNoise()` / `perturbSamples()` derive the exact micro-noise stream a
 *      native hook must reproduce byte-for-byte, seeded from the profile so two
 *      machines agree.
 */

import { VentoFingerprintProfile } from "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs";

/**
 * The surface name fed into the profile's seed derivation. Kept as a constant so
 * the JS reference and any future C++/Rust re-implementation agree on the exact
 * string that keys the audio noise PRNG.
 */
const AUDIO_SURFACE = "audio";

/**
 * The section-5 RFPTargets, by the exact name TextToRFPTarget expects. Enabling
 * both is what forces the audio parameters to their build-constants. Kept as data
 * so `overridesFragment()`, the descriptor and the test stay in sync, and so the
 * list can be audited against RFPTargets.inc in review.
 */
export const SECTION5_TARGETS = Object.freeze([
  "AudioSampleRate", // 39
  "AudioContext", // 49
]);

/**
 * The amplitude of the optional seed-derived micro-noise, in units of a single
 * float sample ([-1, 1] full scale). Chosen tiny enough to be sub-audible and not
 * disturb any real playback, but large enough to dominate the low float bits that
 * a hash reads — the same trade-off canvas noise makes. Frozen so the native hook
 * and this reference cannot drift.
 */
export const AUDIO_NOISE_AMPLITUDE = 1e-7;

/**
 * The fleet-wide default for the section-5 observables. Every value MUST be
 * identical on every Vento install for the cross-machine identity guarantee to
 * hold, so these are frozen constants, NOT derived from the profile seed. They
 * mirror exactly what enabling the corresponding RFPTarget produces in Gecko
 * (44100 / 2 channels), with the one exception called out above: `outputLatency`
 * is pinned to a single fleet-wide value (the Windows RFP constant) rather than
 * the OS-dependent one, because the whole point is identity ACROSS OSes.
 */
export const DEFAULT_AUDIO_PROFILE = Object.freeze({
  // AudioSampleRate(39): PreferredSampleRate returns 44100 under RFP. This is the
  // AudioContext.sampleRate a site reads.
  sampleRate: 44100,

  // AudioContext(49): destination.maxChannelCount is forced to 2 under RFP.
  maxChannelCount: 2,

  // AudioContext(49): OutputLatency() under RFP. The native value is OS-dependent
  // (see residualVariance: latency-os-constant); we pin the Windows constant as
  // the single fleet-wide value so two OSes agree. baseLatency mirrors it (Gecko
  // derives both from the same figure).
  outputLatency: 0.04,
  baseLatency: 0.04,

  // Whether to apply the optional deterministic DSP micro-noise. Off by default:
  // enabling the two RFPTargets already makes the DSP output build-constant for a
  // same-build/same-SIMD fleet, so noise is only needed to also mask cross-CPU
  // SIMD divergence. Turning it on requires the native perturbation hook.
  dspNoise: false,
});

/**
 * The section-5 audio surface bundled as a deterministic profile. Constructed
 * from a (partial) profile merged over DEFAULT_AUDIO_PROFILE plus a master seed
 * (only consulted for the optional DSP micro-noise; the parameters are fleet
 * constants and never seed-derived).
 */
export class VentoAudio {
  /**
   * @param {object} [options]
   * @param {string} [options.seed] Master seed, used only to derive the optional
   *   DSP micro-noise stream. Omitting it is fine when `dspNoise` is off.
   * @param {object} [options.profile] Partial overrides of DEFAULT_AUDIO_PROFILE.
   */
  constructor({ seed = "", profile = {} } = {}) {
    this.seed = typeof seed === "string" ? seed : "";
    this.profile = Object.freeze({ ...DEFAULT_AUDIO_PROFILE, ...profile });
    const p = this.profile;
    if (!Number.isFinite(p.sampleRate) || p.sampleRate <= 0) {
      throw new Error("sampleRate must be a positive number");
    }
    if (!Number.isInteger(p.maxChannelCount) || p.maxChannelCount <= 0) {
      throw new Error("maxChannelCount must be a positive integer");
    }
    if (!Number.isFinite(p.outputLatency) || p.outputLatency < 0) {
      throw new Error("outputLatency must be a non-negative number");
    }
    if (p.dspNoise && !this.seed.length) {
      throw new Error("dspNoise requires a non-empty seed");
    }
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.seed` / `.fields`).
   * The seed is threaded through so the optional DSP micro-noise is derived from
   * the same master secret as canvas/WebGL, keeping every surface on one seed.
   *
   * @param {object} profile A VentoFingerprintProfile-like `{seed, fields}`.
   * @param {object} [overrides] Explicit section-5 overrides taking precedence
   *   over the profile's fields.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_AUDIO_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    return new VentoAudio({
      seed: (profile && profile.seed) || "",
      profile: { ...passthrough, ...overrides },
    });
  }

  /**
   * The flattened set of static audio parameters a site observes. Two VentoAudio
   * built from the same profile return a deep-equal object on any machine — that
   * is the CI-checkable identity property (test_vento_audio.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      sampleRate: p.sampleRate,
      maxChannelCount: p.maxChannelCount,
      baseLatency: p.baseLatency,
      outputLatency: p.outputLatency,
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES both
   * section-5 targets. This is the mechanism that makes the audio parameters
   * deterministic without any native patch: nsRFPService::CreateOverridesFromText
   * parses this comma-separated `+Target` list and each enabled target forces its
   * value to the build-constant reflected in DEFAULT_AUDIO_PROFILE. Merge this
   * fragment into the profile-wide overrides string.
   *
   * @returns {string} e.g. "+AudioSampleRate,+AudioContext"
   */
  overridesFragment() {
    return SECTION5_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the audio knobs that are genuinely pref-controllable.
   * `media.cubeb.force_sample_rate` (dom/media/CubebUtils.cpp,
   * PREF_CUBEB_FORCE_SAMPLE_RATE) hard-pins the output stream sample rate ahead of
   * the RFP path, so the AudioContext.sampleRate stays fixed even in the window
   * before RFP is consulted and regardless of the host device. The target-enable
   * list is intentionally NOT folded in here (it must be MERGED with the rest of
   * the profile's overrides, not overwrite it) — use `overridesFragment()`.
   *
   * @returns {Map<string, number>}
   */
  deterministicPrefs() {
    const p = this.profile;
    return new Map([["media.cubeb.force_sample_rate", p.sampleRate]]);
  }

  /**
   * The deterministic per-origin noise PRNG for the audio DSP surface. Same
   * (seed, origin) on any machine => same float stream, so a native perturbation
   * hook that pulls from an identically-seeded PRNG produces a byte-identical
   * rendered buffer across machines. Delegates to VentoFingerprintProfile so audio
   * shares the exact cyrb128/sfc32 derivation used by canvas/WebGL.
   *
   * @param {string} [origin] Per-origin salt (keeps different sites distinct).
   * @returns {() => number} float generator in [0, 1)
   */
  noiseRng(origin = "") {
    if (!this.seed.length) {
      throw new Error("noiseRng requires a non-empty seed");
    }
    const profile = new VentoFingerprintProfile({ seed: this.seed });
    return profile.noiseRng(AUDIO_SURFACE, origin);
  }

  /**
   * The reference micro-noise stream for the DSP hash: `length` deterministic
   * perturbations in [-AUDIO_NOISE_AMPLITUDE, +AUDIO_NOISE_AMPLITUDE], derived
   * from the profile seed + origin. This is the byte-for-byte contract a native
   * hook must satisfy when `dspNoise` is on — add element i to sample i of the
   * rendered buffer. Two machines with the same profile get the same stream, so
   * the resulting audio hash is identical even if their raw ffvpx FFT differed in
   * the low bits.
   *
   * @param {number} length Number of samples to perturb.
   * @param {string} [origin] Per-origin salt.
   * @returns {Float64Array}
   */
  audioNoise(length, origin = "") {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error("length must be a non-negative integer");
    }
    const rng = this.noiseRng(origin);
    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      // Map [0,1) -> [-1,1) then scale to the sub-audible amplitude.
      out[i] = (rng() * 2 - 1) * AUDIO_NOISE_AMPLITUDE;
    }
    return out;
  }

  /**
   * Apply `audioNoise()` to a copy of a rendered sample buffer — the JS mirror of
   * what the native hook does in-place. Kept so the test can assert that two
   * machines perturb an identical input buffer to an identical output.
   *
   * @param {ArrayLike<number>} samples The rendered float samples.
   * @param {string} [origin] Per-origin salt.
   * @returns {Float64Array}
   */
  perturbSamples(samples, origin = "") {
    const noise = this.audioNoise(samples.length, origin);
    const out = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] + noise[i];
    }
    return out;
  }

  /**
   * A stable, human-auditable descriptor of everything section 5 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    return [
      `rate=${v.sampleRate}`,
      `maxCh=${v.maxChannelCount}`,
      `baseLat=${v.baseLatency}`,
      `outLat=${v.outputLatency}`,
      `dspNoise=${+this.profile.dspNoise}`,
    ].join("|");
  }

  /**
   * Per-surface map of how section 5 is closed: the RFPTarget that carries it, the
   * mechanism, and the exact core hook for auditing. Kept as data so ../README.md
   * and the test stay in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "AudioContext.sampleRate",
        target: "AudioSampleRate",
        id: 39,
        mechanism: "rfp-target + pref",
        injectionPoint:
          "dom/media/CubebUtils.cpp PreferredSampleRate() returns 44100 under " +
          "RFPTarget::AudioSampleRate; also hard-pinnable via " +
          "media.cubeb.force_sample_rate (deterministicPrefs).",
      },
      {
        surface: "destination.maxChannelCount",
        target: "AudioContext",
        id: 49,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/media/webaudio/AudioContext.cpp AudioContext::MaxChannelCount() " +
          "returns 2 under RFPTarget::AudioContext.",
      },
      {
        surface: "baseLatency / outputLatency",
        target: "AudioContext",
        id: 49,
        mechanism: "rfp-target (+ optional native pin for cross-OS)",
        injectionPoint:
          "dom/media/webaudio/AudioContext.cpp AudioContext::OutputLatency() " +
          "returns a fixed but OS-DEPENDENT latency under RFPTarget::AudioContext; " +
          "return getSpoofedValues().outputLatency to pin one fleet-wide value.",
      },
      {
        surface: "OfflineAudioContext DSP hash",
        target: "AudioContext",
        id: 49,
        mechanism: "software DSP (build-constant) + optional seed noise",
        injectionPoint:
          "dom/media/webaudio/FFTBlock.h (ffvpx av_tx) + DynamicsCompressor are " +
          "pure software, so same-build/same-SIMD output is already identical. " +
          "Optional: add perturbSamples() output to the rendered buffer, or force " +
          "the scalar ffvpx kernel — see residualVariance.",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-5 targets does NOT by itself remove.
   * Like sections 6/8, enabling the targets already yields a build-constant for
   * every parameter, so this list is the OPTIONAL native work needed for full
   * cross-OS / cross-CPU identity. Kept honest and as data.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "latency-os-constant",
        channel: "AudioContext base/output latency",
        whyNotTargetOnly:
          "RFPTarget::AudioContext already fixes the latency, but to an " +
          "OS-DEPENDENT constant (mac = 512/sampleRate, win = 0.04, android = " +
          "0.020, other = 0.025). So a mac Vento and a win Vento with the same " +
          "profile still differ on baseLatency/outputLatency.",
        normalisedBy:
          "Pin a single fleet-wide value (DEFAULT_AUDIO_PROFILE.outputLatency).",
        injectionPoint:
          "dom/media/webaudio/AudioContext.cpp AudioContext::OutputLatency() — " +
          "return VentoAudio.getSpoofedValues().outputLatency instead of the " +
          "per-OS #ifdef ladder.",
      },
      {
        id: "dsp-simd-divergence",
        channel: "OfflineAudioContext DSP hash",
        whyNotTargetOnly:
          "Gecko adds no RFP noise to WebAudio buffers; the DynamicsCompressor + " +
          "ffvpx FFT are software, so the rendered hash is identical for a " +
          "same-build/same-SIMD fleet. The residual is cross-CPU SIMD: ffvpx " +
          "av_tx selects SSE/AVX/NEON kernels at runtime, which can differ in the " +
          "low float bits a hash reads.",
        normalisedBy:
          "Either force ffvpx's scalar transform (build/runtime flag) so every " +
          "CPU runs the same kernel, or apply the deterministic seed micro-noise " +
          "(perturbSamples) whose amplitude dominates the low bits.",
        injectionPoint:
          "dom/media/webaudio/ (buffer readback path) — add " +
          "VentoAudio.perturbSamples() output when dspNoise is on; " +
          "perturbSamples()/audioNoise() are the byte-for-byte reference.",
      },
    ];
  }
}
