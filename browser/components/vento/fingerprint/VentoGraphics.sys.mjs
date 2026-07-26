/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Graphics (Canvas / WebGL / WebGPU / WebCodecs) — the isolated,
 * engine-agnostic core of section 3 of FINGERPRINTING_RESEARCH.md, the "fattest"
 * entropy channel and the hardest to make byte-identical across machines.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data + the shared deterministic PRNG:
 * a (partial) profile in, a set of spoofed graphics values, deterministic
 * readback seeds/noise, and a pref map out.
 *
 * WHY THIS CHANNEL IS SPECIAL. Every other channel resolves to "enable an
 * RFPTarget so the value collapses to a build-constant" (sections 6/8) or "pin a
 * static value" (sections 5/7). Section 3 has a sub-surface those tricks do NOT
 * fully close: PIXEL READBACK. `canvas.toDataURL()` / `getImageData()` and WebGL
 * `readPixels()` hash the actual rendered bytes, which depend on the GPU, driver
 * and OS. Firefox's CanvasRandomization / WebGLRandomization targets add noise on
 * top of that render, but the noise is (a) keyed off a RANDOM per-session UUID
 * (so it is not reproducible across machines) and (b) added ON TOP of a
 * hardware-dependent base render (so even with a fixed key, two GPUs still differ
 * in the un-noised bits). See `strategyVerdict()` for the resolution.
 *
 * The channel splits into FOUR sub-surfaces with very different cost:
 *
 *   1. PARAMETER SURFACES (medium complexity, medium testability). Static values
 *      a site reads without touching a framebuffer: WebGL `getParameter` limits +
 *      UNMASKED vendor/renderer, WebGPU adapter limits / `isFallbackAdapter` /
 *      subgroup sizes, WebCodecs supported-config lists. These are closed exactly
 *      like sections 6/8: ENABLE the RFPTargets (`overridesFragment()`) so the
 *      values sanitize to constants, and — for the two that have a genuine value
 *      pref — pin them (`webgl.override-unmasked-vendor/renderer` in
 *      `deterministicPrefs()`). No native patch of their own.
 *
 *   2. READBACK NOISE KEY (the ONE core patch). Firefox already injects
 *      seed-derived noise into canvas/WebGL readback when CanvasRandomization(9) /
 *      EfficientCanvasRandomization(76) / WebGLRandomization(75) are on — but it
 *      salts that noise with a RANDOM per-session UUID
 *      (`nsRFPService::GetBrowsingSessionKey`). Replacing that UUID with
 *      `surfaceSeedHex(surface, origin)` (a deterministic function of the profile
 *      seed) is the single most important injection point in the whole feature
 *      (../README.md). `canvasSeedHex()` / `webglSeedHex()` are the reference; a
 *      native re-implementation must produce the same hex.
 *
 *   3. BASE-RENDER IDENTITY (route (a) vs (b) — the strategy decision this PoC
 *      exists to make). Making the noise KEY deterministic is necessary but NOT
 *      sufficient: the noise is added on top of a base render that still differs
 *      by GPU. Two routes (see `strategyVerdict()`): (a) noise masking alone —
 *      cheap, but cannot guarantee 100% because the un-noised base bits leak; (b)
 *      a unified SOFTWARE render (SwiftShader/WARP for WebGL, software canvas
 *      path) so the base bytes are identical on every machine, then the
 *      deterministic seed-noise on top stays identical too. Verdict: (b) for
 *      readback, gated behind `softwareRender` and pinned via `deterministicPrefs`
 *      (`gfx.canvas.accelerated=false`, `webgl.forbid-hardware=true`,
 *      `gfx.webrender.software=true`). Hardware rendering stays on for everything
 *      that is NOT read back — see `residualVariance()` for the honest cost.
 *
 *   4. READBACK NOISE REFERENCE (optional, for route (a) or to also mask any
 *      software-render residual). `canvasNoise()` / `webglNoise()` derive the
 *      exact per-channel integer delta stream a native hook must reproduce
 *      byte-for-byte, seeded from the profile so two machines agree — the same
 *      contract `VentoAudio.perturbSamples()` provides for the audio DSP hash.
 */

import { VentoFingerprintProfile } from "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs";

/**
 * The surface names fed into the profile's seed derivation. Kept as constants so
 * the JS reference and any future C++/Rust re-implementation agree on the exact
 * strings that key the canvas / WebGL readback noise PRNGs.
 */
const CANVAS_SURFACE = "canvas";
const WEBGL_SURFACE = "webgl";

/**
 * The section-3 RFPTargets, by the exact name TextToRFPTarget expects, grouped by
 * sub-surface. Enabling them is what forces the parameter surfaces to constants
 * and turns on the (now deterministically-keyed) readback noise. Kept as data so
 * `overridesFragment()`, the descriptor and the test stay in sync, and so the
 * list can be audited against RFPTargets.inc in review.
 */
export const SECTION3_TARGETS = Object.freeze([
  // Canvas 2D readback noise (keyed by the deterministic seed, see readback key).
  "CanvasRandomization", // 9
  "EfficientCanvasRandomization", // 76
  // WebGL readback noise.
  "WebGLRandomization", // 75
  // WebGL parameter surfaces: capability + render-info + vendor/renderer sanitize.
  "WebGLRenderCapability", // 59
  "WebGLRenderInfo", // 60
  "WebGLVendorConstant", // 78
  "WebGLRendererConstant", // 80
  // WebGPU parameter surfaces.
  "WebGPULimits", // 64
  "WebGPUIsFallbackAdapter", // 65
  "WebGPUSubgroupSizes", // 66
  // WebCodecs supported-config surface.
  "WebCodecs", // 71
]);

/**
 * Amplitude of the optional seed-derived readback micro-noise, as an absolute
 * per-channel integer delta on an 8-bit RGBA pixel. Chosen to match Firefox's own
 * canvas randomization magnitude (a +/-1..N nudge on a small subset of channels):
 * large enough to dominate the low bits a hash reads, small enough to be
 * imperceptible. Frozen so the native hook and this reference cannot drift.
 */
export const CANVAS_NOISE_AMPLITUDE = 1;

/**
 * The fleet-wide default for the section-3 observables. Every value MUST be
 * identical on every Vento install for the cross-machine identity guarantee to
 * hold, so these are frozen constants, NOT derived from the profile seed. The
 * vendor/renderer strings mirror VentoFingerprintProfile.getSpoofedValues() so the
 * whole feature reports one GPU identity. `softwareRender` and `deterministicNoise`
 * default ON: they encode the strategy verdict (route (b) + the core seed patch),
 * which is the only configuration that makes readback 100% identical across
 * machines (see `strategyVerdict()`).
 */
export const DEFAULT_GRAPHICS_PROFILE = Object.freeze({
  // WebGL UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL (and the plain
  // VENDOR/RENDERER). These are the highest-signal strings a site reads; pinned
  // fleet-wide via webgl.override-unmasked-* (deterministicPrefs).
  unmaskedVendor: "Google Inc. (Intel)",
  unmaskedRenderer:
    "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",

  // A curated, deterministic subset of the WebGL getParameter limits a site
  // enumerates. The exact values matter less than their being fleet-constant;
  // these are a plausible mid-range desktop GPU. Enabling WebGLRenderCapability
  // sanitizes the rest to spec minimums.
  webglParameters: Object.freeze({
    MAX_TEXTURE_SIZE: 16384,
    MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
    MAX_RENDERBUFFER_SIZE: 16384,
    MAX_VIEWPORT_DIMS: Object.freeze([32767, 32767]),
    MAX_VERTEX_ATTRIBS: 16,
    MAX_VERTEX_UNIFORM_VECTORS: 4096,
    MAX_VARYING_VECTORS: 30,
    MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
    MAX_TEXTURE_IMAGE_UNITS: 16,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
    ALIASED_LINE_WIDTH_RANGE: Object.freeze([1, 1]),
    ALIASED_POINT_SIZE_RANGE: Object.freeze([1, 1024]),
    MAX_SAMPLES: 8,
    SHADING_LANGUAGE_VERSION:
      "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
    VERSION: "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
  }),

  // WebGPU adapter surface (targets 64-66). isFallbackAdapter=false is the honest
  // report for a real adapter; the limits are the conservative default tier.
  webgpu: Object.freeze({
    isFallbackAdapter: false,
    subgroupSizes: Object.freeze({ min: 4, max: 128 }),
    limits: Object.freeze({
      maxTextureDimension1D: 8192,
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 2048,
      maxBindGroups: 4,
      maxBufferSize: 268435456,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeInvocationsPerWorkgroup: 256,
    }),
  }),

  // WebCodecs (71): the fleet-wide supported-config list a site probes via
  // VideoDecoder/Encoder.isConfigSupported. A conservative, universally-available
  // set so the answer is identical everywhere.
  webcodecs: Object.freeze({
    videoDecoders: Object.freeze(["vp8", "vp09.00.10.08", "av01.0.04M.08"]),
    videoEncoders: Object.freeze(["vp8", "vp09.00.10.08"]),
    audioDecoders: Object.freeze(["opus", "mp3", "vorbis"]),
    audioEncoders: Object.freeze(["opus"]),
  }),

  // STRATEGY VERDICT, route (b): force a unified software render for readback so
  // the base bytes are identical on every machine. Pinned via deterministicPrefs.
  // On by default because it is the only route that guarantees 100% readback
  // identity; the perf/compat cost is enumerated in residualVariance().
  softwareRender: true,

  // The core patch: make the canvas/WebGL randomization noise reproducible by
  // keying it off the profile seed instead of the random session UUID. On by
  // default; requires the nsRFPService::GetBrowsingSessionKey injection point.
  deterministicNoise: true,
});

/**
 * The section-3 graphics surface bundled as a deterministic profile. Constructed
 * from a (partial) profile merged over DEFAULT_GRAPHICS_PROFILE plus a master seed
 * (consulted only for the readback noise / seed hex; the parameter values are
 * fleet constants and never seed-derived).
 */
export class VentoGraphics {
  /**
   * @param {object} [options]
   * @param {string} [options.seed] Master seed, used to derive the readback noise
   *   key + stream. Required when `deterministicNoise` is on (the default).
   * @param {object} [options.profile] Partial overrides of DEFAULT_GRAPHICS_PROFILE.
   */
  constructor({ seed = "", profile = {} } = {}) {
    this.seed = typeof seed === "string" ? seed : "";
    this.profile = Object.freeze({ ...DEFAULT_GRAPHICS_PROFILE, ...profile });
    const p = this.profile;
    if (typeof p.unmaskedVendor !== "string" || !p.unmaskedVendor.length) {
      throw new Error("unmaskedVendor must be a non-empty string");
    }
    if (typeof p.unmaskedRenderer !== "string" || !p.unmaskedRenderer.length) {
      throw new Error("unmaskedRenderer must be a non-empty string");
    }
    if (p.deterministicNoise && !this.seed.length) {
      throw new Error("deterministicNoise requires a non-empty seed");
    }
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.seed` / `.fields`).
   * Section-3 fields are threaded from the profile; the seed is shared with
   * canvas/WebGL/audio so every surface derives from one master secret. The
   * profile's `gpuVendor` / `gpuRenderer` map onto the UNMASKED strings when no
   * explicit section-3 override is given, so a single GPU identity flows through.
   *
   * @param {object} profile A VentoFingerprintProfile-like `{seed, fields}`.
   * @param {object} [overrides] Explicit section-3 overrides taking precedence.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_GRAPHICS_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    if (!("unmaskedVendor" in fields) && "gpuVendor" in fields) {
      passthrough.unmaskedVendor = fields.gpuVendor;
    }
    if (!("unmaskedRenderer" in fields) && "gpuRenderer" in fields) {
      passthrough.unmaskedRenderer = fields.gpuRenderer;
    }
    return new VentoGraphics({
      seed: (profile && profile.seed) || "",
      profile: { ...passthrough, ...overrides },
    });
  }

  /**
   * The flattened set of static graphics values a site observes. Two VentoGraphics
   * built from the same profile return a deep-equal object on any machine — that
   * is the CI-checkable identity property (test_vento_graphics.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      unmaskedVendor: p.unmaskedVendor,
      unmaskedRenderer: p.unmaskedRenderer,
      webglParameters: p.webglParameters,
      webgpu: p.webgpu,
      webcodecs: p.webcodecs,
      softwareRender: p.softwareRender,
      deterministicNoise: p.deterministicNoise,
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-3 target. nsRFPService::CreateOverridesFromText parses this
   * comma-separated `+Target` list: the parameter targets sanitize
   * getParameter/WebGPU/WebCodecs to constants, and the three randomization
   * targets turn on the readback noise (made deterministic by the seed patch).
   * Merge this fragment into the profile-wide overrides string — never write it as
   * a standalone pref.
   *
   * @returns {string} e.g. "+CanvasRandomization,+WebGLRandomization,..."
   */
  overridesFragment() {
    return SECTION3_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the section-3 knobs that are genuinely pref-controllable:
   *   - `webgl.override-unmasked-vendor/renderer` (DataMutexString) hard-pin the
   *     UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL strings fleet-wide,
   *     independent of the host GPU;
   *   - when `softwareRender` is on (the strategy verdict, route (b)),
   *     `gfx.canvas.accelerated=false` forces the software canvas 2D path,
   *     `webgl.forbid-hardware=true` forbids the hardware WebGL backend (falling
   *     back to the software rasterizer), and `gfx.webrender.software=true` runs
   *     WebRender in software — together making the readback BASE bytes identical
   *     across machines so the deterministic noise on top stays identical.
   * The target-enable list is intentionally NOT folded in here (it must be MERGED
   * with the rest of the profile's overrides) — use `overridesFragment()`.
   *
   * @returns {Map<string, string|boolean>}
   */
  deterministicPrefs() {
    const p = this.profile;
    const prefs = new Map([
      ["webgl.override-unmasked-vendor", p.unmaskedVendor],
      ["webgl.override-unmasked-renderer", p.unmaskedRenderer],
    ]);
    if (p.softwareRender) {
      prefs.set("gfx.canvas.accelerated", false);
      prefs.set("webgl.forbid-hardware", true);
      prefs.set("gfx.webrender.software", true);
    }
    return prefs;
  }

  /**
   * Deterministic 128-bit readback noise key (hex) for canvas, per origin. This is
   * the value that REPLACES the random session UUID in
   * nsRFPService::GetBrowsingSessionKey — same (seed, origin) on any machine =>
   * same hex, so the canvas noise is reproducible across machines. Delegates to
   * VentoFingerprintProfile so it shares the exact cyrb128 derivation a native
   * re-implementation must match.
   *
   * @param {string} [origin] Per-origin salt (keeps different sites distinct).
   * @returns {string} 32-hex-char key.
   */
  canvasSeedHex(origin = "") {
    return this.#profile().surfaceSeedHex(CANVAS_SURFACE, origin);
  }

  /**
   * Deterministic 128-bit readback noise key (hex) for WebGL, per origin. Same
   * contract as `canvasSeedHex` for the WebGLRandomization(75) noise path.
   *
   * @param {string} [origin] Per-origin salt.
   * @returns {string} 32-hex-char key.
   */
  webglSeedHex(origin = "") {
    return this.#profile().surfaceSeedHex(WEBGL_SURFACE, origin);
  }

  /**
   * The deterministic per-origin noise PRNG for a readback surface. Same (seed,
   * surface, origin) on any machine => same float stream, so a native perturbation
   * hook that pulls from an identically-seeded PRNG produces a byte-identical
   * readback across machines.
   *
   * @param {string} surface CANVAS_SURFACE or WEBGL_SURFACE.
   * @param {string} [origin] Per-origin salt.
   * @returns {() => number} float generator in [0, 1)
   */
  noiseRng(surface, origin = "") {
    if (!this.seed.length) {
      throw new Error("noiseRng requires a non-empty seed");
    }
    return this.#profile().noiseRng(surface, origin);
  }

  /**
   * The reference readback micro-noise stream: `length` deterministic integer
   * per-channel deltas in [-CANVAS_NOISE_AMPLITUDE, +CANVAS_NOISE_AMPLITUDE],
   * derived from the profile seed + origin. This is the byte-for-byte contract a
   * native hook must satisfy when applying noise to a readback buffer — add
   * element i to channel i of the RGBA bytes. Two machines with the same profile
   * get the same stream, so the resulting pixel hash is identical.
   *
   * @param {number} length Number of channel deltas to produce.
   * @param {string} surface CANVAS_SURFACE or WEBGL_SURFACE.
   * @param {string} [origin] Per-origin salt.
   * @returns {Int8Array}
   */
  readbackNoise(length, surface, origin = "") {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error("length must be a non-negative integer");
    }
    const rng = this.noiseRng(surface, origin);
    const span = 2 * CANVAS_NOISE_AMPLITUDE + 1;
    const out = new Int8Array(length);
    for (let i = 0; i < length; i++) {
      // Map [0,1) -> integer in [-A, +A] uniformly.
      out[i] = Math.floor(rng() * span) - CANVAS_NOISE_AMPLITUDE;
    }
    return out;
  }

  /**
   * Convenience: the canvas readback noise stream.
   *
   * @param {number} length Number of channel deltas to produce.
   * @param {string} [origin] Per-origin salt.
   * @returns {Int8Array}
   */
  canvasNoise(length, origin = "") {
    return this.readbackNoise(length, CANVAS_SURFACE, origin);
  }

  /**
   * Convenience: the WebGL readback noise stream.
   *
   * @param {number} length Number of channel deltas to produce.
   * @param {string} [origin] Per-origin salt.
   * @returns {Int8Array}
   */
  webglNoise(length, origin = "") {
    return this.readbackNoise(length, WEBGL_SURFACE, origin);
  }

  /**
   * Apply `readbackNoise()` to a copy of an RGBA byte buffer — the JS mirror of
   * what the native hook does in-place, with 8-bit wraparound clamping to [0,255].
   * Kept so the test can assert two machines perturb an identical input buffer to
   * an identical output.
   *
   * @param {ArrayLike<number>} bytes The rendered RGBA bytes.
   * @param {string} surface CANVAS_SURFACE or WEBGL_SURFACE.
   * @param {string} [origin] Per-origin salt.
   * @returns {Uint8ClampedArray}
   */
  perturbPixels(bytes, surface, origin = "") {
    const noise = this.readbackNoise(bytes.length, surface, origin);
    const out = new Uint8ClampedArray(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      out[i] = bytes[i] + noise[i];
    }
    return out;
  }

  /**
   * A stable, human-auditable descriptor of everything section 3 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const p = this.profile;
    return [
      `vendor=${p.unmaskedVendor}`,
      `renderer=${p.unmaskedRenderer}`,
      `maxTex=${p.webglParameters.MAX_TEXTURE_SIZE}`,
      `webgpuFallback=${+p.webgpu.isFallbackAdapter}`,
      `vdec=${p.webcodecs.videoDecoders.join("/")}`,
      `sw=${+p.softwareRender}`,
      `detNoise=${+p.deterministicNoise}`,
    ].join("|");
  }

  /**
   * The PoC strategy decision this task exists to make: route (a) noise masking vs
   * route (b) unified software render, per sub-surface. Returned as structured
   * data so the write-up (GRAPHICS_FINGERPRINT_POC.md), README and test cite one
   * source of truth. Verdict: parameters -> enable+pin targets; readback -> route
   * (b) software render for byte-identical base + the deterministic seed key on
   * top; hardware rendering stays on for non-readback drawing.
   *
   * @returns {{decision:string, routes:object, chosen:string, rationale:string}}
   */
  strategyVerdict() {
    return {
      decision:
        "Split by sub-surface: pin the parameter surfaces via RFPTargets, and " +
        "close pixel readback with route (b) (unified software render) plus the " +
        "deterministic seed key, NOT route (a) alone.",
      routes: {
        a: {
          name: "deterministic noise masking over the real (hardware) render",
          pro: "cheap, no perf hit, reuses Firefox's existing randomization path",
          con:
            "the noise is ADDED on top of a hardware-dependent base render, so " +
            "the un-noised base bits still leak GPU/driver differences — cannot " +
            "guarantee 100% cross-machine identity for a readback hash",
        },
        b: {
          name: "unified software render (SwiftShader/WARP + software canvas) for readback",
          pro:
            "base bytes are identical on every machine, so a readback hash is " +
            "byte-identical fleet-wide — the only route that reaches the 100% " +
            "guarantee the feature promises",
          con:
            "software rendering is slower and can differ from hardware output " +
            "visually; mitigated by keeping HARDWARE render for on-screen drawing " +
            "and only forcing software for the readback path",
        },
      },
      chosen: "b-for-readback-plus-deterministic-seed",
      rationale:
        "Making the noise key deterministic (the core nsRFPService patch) is " +
        "necessary but not sufficient, because route (a)'s base render still " +
        "diverges by GPU. Route (b) removes that divergence at the source; the " +
        "deterministic seed noise then rides identically on top. Parameter " +
        "surfaces need neither — enabling their RFPTargets already collapses them " +
        "to fleet constants.",
    };
  }

  /**
   * Per-surface map of how section 3 is closed: the RFPTarget(s) that carry it, the
   * mechanism, and the exact core hook for auditing. Kept as data so ../README.md
   * and the test stay in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, targets:string[], mechanism:string,
   *   injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "canvas/WebGL readback noise KEY (the one core patch)",
        targets: [
          "CanvasRandomization",
          "EfficientCanvasRandomization",
          "WebGLRandomization",
        ],
        mechanism: "deterministic seed replaces the random session UUID",
        injectionPoint:
          "toolkit/components/resistfingerprinting/nsRFPService.cpp " +
          "nsRFPService::GetBrowsingSessionKey() — return canvasSeedHex(origin) / " +
          "webglSeedHex(origin) instead of nsID::GenerateUUID().",
      },
      {
        surface: "WebGL UNMASKED vendor/renderer",
        targets: [
          "WebGLRenderInfo",
          "WebGLVendorConstant",
          "WebGLRendererConstant",
        ],
        mechanism: "rfp-target sanitize + value pref",
        injectionPoint:
          "dom/canvas/WebGLContext + webgl.override-unmasked-vendor/renderer " +
          "(deterministicPrefs) pin the strings fleet-wide.",
      },
      {
        surface: "WebGL getParameter limits",
        targets: ["WebGLRenderCapability"],
        mechanism: "rfp-target",
        injectionPoint:
          "dom/canvas/WebGLContext getParameter — RFPTarget::WebGLRenderCapability " +
          "sanitizes limits to spec minimums; getSpoofedValues().webglParameters " +
          "is the fleet-wide reported set.",
      },
      {
        surface: "WebGPU limits / isFallbackAdapter / subgroup sizes",
        targets: [
          "WebGPULimits",
          "WebGPUIsFallbackAdapter",
          "WebGPUSubgroupSizes",
        ],
        mechanism: "rfp-target",
        injectionPoint:
          "dom/webgpu adapter info — the three targets clamp the reported adapter " +
          "shape; getSpoofedValues().webgpu is the fleet-wide set.",
      },
      {
        surface: "WebCodecs supported configs",
        targets: ["WebCodecs"],
        mechanism: "rfp-target",
        injectionPoint:
          "dom/media/webcodecs isConfigSupported — RFPTarget::WebCodecs normalizes " +
          "the answer; getSpoofedValues().webcodecs is the fleet-wide list.",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-3 targets + making the noise key
   * deterministic does NOT by itself remove. This is the honest cost of the
   * channel and the crux of the strategy decision: the parameter surfaces are
   * fully closed, but readback identity requires the route-(b) software render,
   * whose perf/compat price is enumerated here. Kept honest and as data.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "readback-base-render-divergence",
        channel: "canvas 2D readback + WebGL readPixels",
        whyNotTargetOnly:
          "The randomization targets add noise ON TOP of the real render, and the " +
          "noise key can be made deterministic, but the un-noised base bytes still " +
          "depend on GPU/driver/OS — so route (a) noise alone cannot reach 100% " +
          "cross-machine identity for a readback hash.",
        normalisedBy:
          "Route (b): force a unified software render for the readback path " +
          "(softwareRender -> gfx.canvas.accelerated=false, webgl.forbid-hardware=" +
          "true, gfx.webrender.software=true) so the base bytes are identical; the " +
          "deterministic seed noise then rides identically on top.",
        injectionPoint:
          "gfx/ readback path + deterministicPrefs(); for full cross-OS identity " +
          "the software rasterizer itself (SwiftShader/llvmpipe/WARP) must be the " +
          "same build on every platform — a bundled-binary/build remainder.",
      },
      {
        id: "software-render-cost",
        channel: "graphics performance / visual parity",
        whyNotTargetOnly:
          "Route (b) trades performance and exact visual parity for identity: " +
          "software rendering is slower and can differ from hardware output for " +
          "on-screen content.",
        normalisedBy:
          "Keep HARDWARE rendering for on-screen drawing and force software ONLY " +
          "for the readback path (toDataURL/getImageData/readPixels), so the perf " +
          "hit is scoped to fingerprint-relevant operations.",
        injectionPoint:
          "gfx/ — a readback-scoped software path rather than a global " +
          "software-render switch; the prefs here are the coarse PoC stand-in.",
      },
      {
        id: "canvas-text-glyph-metrics",
        channel: "canvas text rendering",
        whyNotTargetOnly:
          "Text drawn to a canvas rasterizes glyphs whose advances/kerning/hinting " +
          "are hardware- and font-backend-dependent — the same root as the fonts " +
          "channel glyph metrics (section 4).",
        normalisedBy:
          "Shares the section-4 remainder: a deterministic software text " +
          "rasterizer + bundled profile font binaries, so canvas text is identical " +
          "across machines. Closed together with VentoFonts glyph metrics.",
        injectionPoint:
          "gfx/thebes + gfx/2d text path — see VentoFonts.residualVariance() " +
          "(fonts-glyph-metrics); one shared software rasterizer serves both.",
      },
      {
        id: "cross-cpu-software-simd",
        channel: "software rasterizer low-bit divergence",
        whyNotTargetOnly:
          "Even a unified software rasterizer can differ in the lowest bits across " +
          "CPU SIMD tiers (SSE/AVX/NEON), the same residual as the audio DSP hash.",
        normalisedBy:
          "Optional: apply the deterministic seed micro-noise (perturbPixels) whose " +
          "amplitude dominates the low bits, or force the scalar rasterizer kernel.",
        injectionPoint:
          "gfx/ readback path — add perturbPixels() output; readbackNoise()/" +
          "perturbPixels() are the byte-for-byte reference.",
      },
    ];
  }

  #profile() {
    return new VentoFingerprintProfile({ seed: this.seed });
  }
}
