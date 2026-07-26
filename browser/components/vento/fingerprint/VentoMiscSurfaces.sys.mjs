/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Misc Web-API Surfaces — the isolated, engine-agnostic core of section 8
 * ("Прочие web-API поверхности") of FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data: a (partial) profile in, a
 * deterministic set of spoofed values + a pref map out.
 *
 * The seven surfaces of section 8, with their RFPTarget id (RFPTargets.inc):
 *
 *   SpeechSynthesis (5)            list of TTS voices (heavily OS-dependent)
 *   ScreenOrientation (4)         screen.orientation type + angle
 *   VideoElementMozFrames (32)    HTMLVideoElement.moz{Parsed,Decoded,Presented,
 *                                 Painted}Frames
 *   VideoElementMozFrameDelay(33) HTMLVideoElement.mozFrameDelay
 *   VideoElementPlaybackQuality(34) getVideoPlaybackQuality()
 *   WebVTT (63)                   WebVTT cue exposure
 *   FrameRate (46)                vsync / refresh rate as seen through timing
 *   IMEStyle (81)                 input-method composition style
 *   MediaError (50)               MediaError.message decoder text
 *   UseStandinsForNativeColors(48) system theme colors
 *
 * KEY FINDING (verified against the tree, RFPTargets.inc + nsRFPService.cpp): all
 * ten of these already have spoofing code in Gecko gated behind their RFPTarget.
 * When the target is ENABLED the value is forced to a build-constant (empty voice
 * list, zeroed frame counters, hidden WebVTT/IME, blank MediaError message,
 * stand-in colors, fixed 60Hz, landscape-primary/0deg). A build constant is by
 * definition identical on every machine, so — unlike canvas/WebGL (section 3) —
 * section 8 needs NO native patch of its own: it is fully closed by ENABLING the
 * right RFPTargets via the `privacy.fingerprintingProtection.overrides` pref
 * (format: comma-separated `+Target` / `-Target`, parsed by
 * nsRFPService::CreateOverridesFromText). `overridesFragment()` emits exactly
 * that fragment and `deterministicPrefs()` adds the two genuine value prefs
 * (layout.frame_rate, ui.use_standins_for_native_colors).
 *
 * The ONLY thing that would need a native hook is if a profile wants a *non-empty
 * unified* voice list or a *specific* IME style instead of the deny-by-default
 * (empty/hidden) that enabling the target gives for free — that native remainder
 * is enumerated honestly in `residualVariance()`. So the deliverable mirrors the
 * network module: "what enabling the existing RFPTargets already gives" vs. "the
 * small optional native remainder".
 */

/**
 * The section-8 RFPTargets, by the exact name TextToRFPTarget expects. Enabling
 * every one of these is what forces each surface to its build-constant. Kept as
 * data so `overridesFragment()`, the descriptor and the test stay in sync, and so
 * the list can be audited against RFPTargets.inc in review.
 */
export const SECTION8_TARGETS = Object.freeze([
  "ScreenOrientation", // 4
  "SpeechSynthesis", // 5
  "VideoElementMozFrames", // 32
  "VideoElementMozFrameDelay", // 33
  "VideoElementPlaybackQuality", // 34
  "FrameRate", // 46
  "UseStandinsForNativeColors", // 48
  "MediaError", // 50
  "WebVTT", // 63
  "IMEStyle", // 81
]);

/**
 * The fleet-wide default for the section-8 observables. Every value MUST be
 * identical on every Vento install for the cross-machine identity guarantee to
 * hold — that is the whole point — so these are frozen constants, NOT derived
 * from the profile seed (a seed-varied value here would make two machines with
 * the same profile differ). The defaults mirror exactly what enabling the
 * corresponding RFPTarget produces in Gecko, so the module is a faithful
 * reference for what a site actually observes.
 */
export const DEFAULT_MISC_PROFILE = Object.freeze({
  // SpeechSynthesis(5): deny-by-default. Enabling the target hides OS voices, so
  // getVoices() returns []. A non-empty *unified* list is possible but needs a
  // native voice-registry hook (see residualVariance) — the empty list is the
  // zero-cost, already-deterministic choice.
  speechVoices: Object.freeze([]),

  // ScreenOrientation(4): pinned so orientation cannot leak a real device.
  screenOrientationType: "landscape-primary",
  screenOrientationAngle: 0,

  // VideoElementMozFrames(32) / MozFrameDelay(33) / PlaybackQuality(34): all
  // decode/paint counters zeroed. These are Gecko-specific stats a tracker can
  // read off a <video>; zero is what the enabled targets return.
  videoMozParsedFrames: 0,
  videoMozDecodedFrames: 0,
  videoMozPresentedFrames: 0,
  videoMozPaintedFrames: 0,
  videoMozFrameDelay: 0,
  videoTotalFrames: 0,
  videoDroppedFrames: 0,
  videoCorruptedFrames: 0,

  // WebVTT(63): cue metadata hidden.
  webvttExposed: false,

  // FrameRate(46) / vsync: fixed 60Hz. Also pin-able via layout.frame_rate.
  frameRate: 60,

  // IMEStyle(81): composition style hidden (deny-by-default).
  imeStyleHidden: true,

  // MediaError(50): decoder error text unified to blank — the free-form message
  // is otherwise a codec/OS tell.
  mediaErrorMessage: "",

  // UseStandinsForNativeColors(48): return stand-in colors, not the OS theme.
  useStandinsForNativeColors: true,
});

/**
 * The section-8 surfaces bundled as a deterministic profile. Constructed from a
 * (partial) profile merged over DEFAULT_MISC_PROFILE, so callers only override
 * what the Vento panel exposes.
 */
export class VentoMiscSurfaces {
  /**
   * @param {object} [profile] Partial overrides of DEFAULT_MISC_PROFILE.
   */
  constructor(profile = {}) {
    this.profile = Object.freeze({ ...DEFAULT_MISC_PROFILE, ...profile });
    const p = this.profile;
    if (!Number.isFinite(p.frameRate) || p.frameRate <= 0) {
      throw new Error("frameRate must be a positive number");
    }
    if (!Array.isArray(p.speechVoices)) {
      throw new Error("speechVoices must be an array");
    }
    if (typeof p.mediaErrorMessage !== "string") {
      throw new Error("mediaErrorMessage must be a string");
    }
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.fields`). Section 8
   * values are intentionally fleet-wide constants, not seed-derived, so this only
   * threads through any explicit section-8 fields the profile carries; it does
   * NOT consult the seed. Keeping the constructor symmetric with the other
   * fingerprint modules.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_MISC_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    return new VentoMiscSurfaces({ ...passthrough, ...overrides });
  }

  /**
   * The flattened set of static values a site observes across all section-8
   * surfaces. Two VentoMiscSurfaces built from the same profile return a
   * deep-equal object on any machine — that is the CI-checkable identity
   * property (test_vento_misc_surfaces.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      speechVoices: p.speechVoices.map(v => ({ ...v })),
      screenOrientation: {
        type: p.screenOrientationType,
        angle: p.screenOrientationAngle,
      },
      videoPlaybackQuality: {
        creationTime: 0,
        totalVideoFrames: p.videoTotalFrames,
        droppedVideoFrames: p.videoDroppedFrames,
        corruptedVideoFrames: p.videoCorruptedFrames,
      },
      videoMozFrames: {
        mozParsedFrames: p.videoMozParsedFrames,
        mozDecodedFrames: p.videoMozDecodedFrames,
        mozPresentedFrames: p.videoMozPresentedFrames,
        mozPaintedFrames: p.videoMozPaintedFrames,
        mozFrameDelay: p.videoMozFrameDelay,
      },
      webvttExposed: p.webvttExposed,
      frameRate: p.frameRate,
      imeStyleHidden: p.imeStyleHidden,
      mediaErrorMessage: p.mediaErrorMessage,
      useStandinsForNativeColors: p.useStandinsForNativeColors,
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-8 target. This is the mechanism that makes the surfaces deterministic
   * without any native patch: nsRFPService::CreateOverridesFromText parses this
   * comma-separated `+Target` list and each enabled target forces its surface to
   * the build-constant reflected in DEFAULT_MISC_PROFILE. Merge this fragment into
   * the profile-wide overrides string (the master privacy.fingerprintingProtection
   * toggle is owned by the top-level profile applier, not this sub-module).
   *
   * @returns {string} e.g. "+ScreenOrientation,+SpeechSynthesis,..."
   */
  overridesFragment() {
    return SECTION8_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the section-8 knobs that are genuinely pref-controllable
   * (i.e. carry a real value, not just a target toggle). Pref names verified
   * against StaticPrefList.yaml. The target-enable list is intentionally NOT
   * folded in here as a single pref write, because it must be MERGED with the
   * rest of the profile's overrides fragment rather than overwrite it — use
   * `overridesFragment()` for that.
   *
   * @returns {Map<string, boolean|number>}
   */
  deterministicPrefs() {
    const p = this.profile;
    return new Map([
      // FrameRate(46): a fixed refresh rate so vsync-derived timing can't leak the
      // real display. -1 would mean "match the monitor"; pin to the profile value.
      ["layout.frame_rate", p.frameRate],
      // UseStandinsForNativeColors(48): return stand-in colors instead of the OS
      // theme palette.
      ["ui.use_standins_for_native_colors", p.useStandinsForNativeColors],
    ]);
  }

  /**
   * A stable, human-auditable descriptor of everything section 8 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    return [
      `voices=${v.speechVoices.length}`,
      `orient=${v.screenOrientation.type}/${v.screenOrientation.angle}`,
      `fps=${v.frameRate}`,
      `webvtt=${+v.webvttExposed}`,
      `ime=${+v.imeStyleHidden}`,
      `mediaErr="${v.mediaErrorMessage}"`,
      `standins=${+v.useStandinsForNativeColors}`,
      `vq=${v.videoPlaybackQuality.totalVideoFrames}/${v.videoPlaybackQuality.droppedVideoFrames}`,
    ].join("|");
  }

  /**
   * Per-surface map of how section 8 is closed: the RFPTarget that carries it, the
   * mechanism (all "rfp-target" — enable via the overrides fragment), and the
   * exact core hook for auditing. Kept as data so ../README.md and the test stay
   * in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "SpeechSynthesis voices",
        target: "SpeechSynthesis",
        id: 5,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/media/webspeech/synth/nsSynthVoiceRegistry — voice enumeration is " +
          "gated on RFPTarget::SpeechSynthesis; enabled => empty list.",
      },
      {
        surface: "ScreenOrientation",
        target: "ScreenOrientation",
        id: 4,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/ScreenOrientation + nsRFPService — enabled => landscape-primary/0.",
      },
      {
        surface: "Video mozFrames / mozFrameDelay / playback quality",
        target:
          "VideoElementMozFrames / VideoElementMozFrameDelay / VideoElementPlaybackQuality",
        id: 32,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/html/HTMLVideoElement.cpp — the moz* counters and " +
          "getVideoPlaybackQuality() are zeroed under these targets.",
      },
      {
        surface: "WebVTT cue metadata",
        target: "WebVTT",
        id: 63,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/media/webvtt — cue exposure gated on RFPTarget::WebVTT.",
      },
      {
        surface: "FrameRate / vsync",
        target: "FrameRate",
        id: 46,
        mechanism: "rfp-target + pref",
        injectionPoint:
          "gfx vsync source; also pinnable via layout.frame_rate (deterministicPrefs).",
      },
      {
        surface: "IME composition style",
        target: "IMEStyle",
        id: 81,
        mechanism: "rfp-target",
        injectionPoint:
          "widget IME path — composition style hidden under RFPTarget::IMEStyle.",
      },
      {
        surface: "MediaError message",
        target: "MediaError",
        id: 50,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/html/MediaError — message blanked under RFPTarget::MediaError.",
      },
      {
        surface: "Native colors",
        target: "UseStandinsForNativeColors",
        id: 48,
        mechanism: "rfp-target + pref",
        injectionPoint:
          "widget/LookAndFeel; also ui.use_standins_for_native_colors (deterministicPrefs).",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-8 targets does NOT by itself remove.
   * Section 8 is unusual in that enabling the targets already yields a
   * build-constant (deny-by-default) for every surface, so this list is only the
   * OPTIONAL native work needed if a profile wants a richer *positive* value
   * (a non-empty unified voice list, a specific IME style) instead of the empty/
   * hidden default. Kept honest and as data, mirroring the network module.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "speech-voice-list-contents",
        channel: "SpeechSynthesis (positive unified list only)",
        whyNotTargetOnly:
          "Enabling RFPTarget::SpeechSynthesis makes getVoices() return [] on " +
          "every machine (already deterministic). Exposing a NON-EMPTY unified " +
          "list identical across machines cannot come from a pref — the voices " +
          "otherwise originate from the OS TTS registry.",
        normalisedBy:
          "Default (empty list) needs nothing. For a positive unified list, feed " +
          "profile.speechVoices from the native voice registry instead of the OS.",
        injectionPoint:
          "nsSynthVoiceRegistry::GetVoices — when RFP is active, return " +
          "VentoMiscSurfaces.getSpoofedValues().speechVoices instead of the empty " +
          "list (or the OS list).",
      },
      {
        id: "ime-composition-style-contents",
        channel: "IMEStyle (positive style only)",
        whyNotTargetOnly:
          "Enabling RFPTarget::IMEStyle hides the composition style (deterministic). " +
          "A specific spoofed style rather than 'hidden' would need a widget hook.",
        normalisedBy:
          "Default (hidden) needs nothing; a positive style is an optional native hook.",
        injectionPoint:
          "widget IME composition path — substitute profile.imeStyle when a " +
          "positive value is configured.",
      },
    ];
  }
}
