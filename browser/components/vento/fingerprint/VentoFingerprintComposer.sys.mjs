/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Fingerprint Composer — the "deny by default" checklist and the single
 * point that turns a VentoFingerprintProfile into ONE applied configuration.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo. This module owns the top-level composition
 * that the per-channel modules (VentoNavigator/Screen/Graphics/... — sections 1-8)
 * deliberately left out: the master `privacy.fingerprintingProtection` toggle, the
 * merged `privacy.fingerprintingProtection.overrides` string, the merged pref map,
 * and the deterministic-seed pref that the one native injection point reads.
 *
 * The "deny by default" mechanism from the research doc is realised here as a
 * closed checklist over RFPTargets.inc: every one of the surface-bearing targets
 * (ids 1..81) MUST carry an explicit disposition —
 *
 *   pinned   a channel owns it: enabled AND its value pinned to the profile
 *   enabled  enabled at the composer level (deterministic build-constant) without
 *            a dedicated channel object yet
 *   blocked  explicitly force-DISABLED (`-Target`) because enabling it would
 *            introduce per-machine randomness or conflict with our chosen strategy
 *   policy   an orthogonal extraction/permission gate left at the Gecko default on
 *            purpose, recorded so the decision is auditable
 *
 * A target that is neither pinned by a channel nor listed here is a coverage HOLE,
 * and `coverageReport()` / the xpcshell test fail loudly. That is what makes the
 * guarantee "any surface is either conformed to the profile or blocked" a
 * machine-checked property rather than a hope.
 */

import {
  VentoNavigator,
  SECTION1_TARGETS,
} from "resource:///modules/fingerprint/VentoNavigator.sys.mjs";
import {
  VentoScreenWindow,
  SECTION2_TARGETS,
} from "resource:///modules/fingerprint/VentoScreenWindow.sys.mjs";
import {
  VentoGraphics,
  SECTION3_TARGETS,
} from "resource:///modules/fingerprint/VentoGraphics.sys.mjs";
import {
  VentoFonts,
  SECTION4_TARGETS,
} from "resource:///modules/fingerprint/VentoFonts.sys.mjs";
import {
  VentoAudio,
  SECTION5_TARGETS,
} from "resource:///modules/fingerprint/VentoAudio.sys.mjs";
import {
  VentoInputDevices,
  SECTION6_TARGETS,
} from "resource:///modules/fingerprint/VentoInputDevices.sys.mjs";
import {
  VentoTimeLocale,
  SECTION7_TARGETS,
} from "resource:///modules/fingerprint/VentoTimeLocale.sys.mjs";
import {
  VentoMiscSurfaces,
  SECTION8_TARGETS,
} from "resource:///modules/fingerprint/VentoMiscSurfaces.sys.mjs";

/**
 * The canonical surface-bearing RFPTargets, ordered by their id in
 * toolkit/components/resistfingerprinting/RFPTargets.inc (ids 1..81). The two
 * sentinels — IsAlwaysEnabledForPrecompute(0) and AllTargets(127) — are NOT
 * surfaces and are intentionally excluded. This list is the checklist the whole
 * "deny by default" guarantee is measured against; it MUST stay in lockstep with
 * RFPTargets.inc, and `test_vento_fingerprint_composer.js` asserts its length and
 * that every entry has a disposition.
 */
export const ALL_RFP_TARGETS = Object.freeze([
  "TouchEvents", // 1
  "PointerEvents", // 2
  "KeyboardEvents", // 3
  "ScreenOrientation", // 4
  "SpeechSynthesis", // 5
  "CSSPrefersColorScheme", // 6
  "CSSPrefersReducedMotion", // 7
  "CSSPrefersContrast", // 8
  "CanvasRandomization", // 9
  "CanvasImageExtractionPrompt", // 10
  "CanvasExtractionFromThirdPartiesIsBlocked", // 11
  "CanvasExtractionBeforeUserInputIsBlocked", // 12
  "JSLocale", // 13
  "NavigatorAppVersion", // 14
  "NavigatorBuildID", // 15
  "NavigatorHWConcurrency", // 16
  "NavigatorOscpu", // 17
  "NavigatorPlatform", // 18
  "NavigatorUserAgent", // 19
  "PdfjsSpoof", // 20
  "StreamVideoFacingMode", // 21
  "JSDateTimeUTC", // 22
  "JSMathFdlibm", // 23
  "Gamepad", // 24
  "HttpUserAgent", // 25
  "WindowOuterSize", // 26
  "WindowScreenXY", // 27
  "WindowInnerScreenXY", // 28
  "ScreenPixelDepth", // 29
  "ScreenRect", // 30
  "ScreenAvailRect", // 31
  "VideoElementMozFrames", // 32
  "VideoElementMozFrameDelay", // 33
  "VideoElementPlaybackQuality", // 34
  "ReduceTimerPrecision", // 35
  "WidgetEvents", // 36
  "MediaDevices", // 37
  "MediaCapabilities", // 38
  "AudioSampleRate", // 39
  "NetworkConnection", // 40
  "WindowDevicePixelRatio", // 41
  "MouseEventScreenPoint", // 42
  "FontVisibilityBaseSystem", // 43
  "FontVisibilityLangPack", // 44
  "DeviceSensors", // 45
  "FrameRate", // 46
  "RoundWindowSize", // 47
  "UseStandinsForNativeColors", // 48
  "AudioContext", // 49
  "MediaError", // 50
  "DOMStyleOsxFontSmoothing", // 51
  "CSSDeviceSize", // 52
  "CSSColorInfo", // 53
  "CSSResolution", // 54
  "CSSPrefersReducedTransparency", // 55
  "CSSInvertedColors", // 56
  "CSSVideoDynamicRange", // 57
  "CSSPointerCapabilities", // 58
  "WebGLRenderCapability", // 59
  "WebGLRenderInfo", // 60
  "SiteSpecificZoom", // 61
  "FontVisibilityRestrictGenerics", // 62
  "WebVTT", // 63
  "WebGPULimits", // 64
  "WebGPUIsFallbackAdapter", // 65
  "WebGPUSubgroupSizes", // 66
  "JSLocalePrompt", // 67
  "ScreenAvailToResolution", // 68
  "UseHardcodedFontSubstitutes", // 69
  "DiskStorageLimit", // 70
  "WebCodecs", // 71
  "MaxTouchPoints", // 72
  "MaxTouchPointsCollapse", // 73
  "NavigatorHWConcurrencyTiered", // 74
  "WebGLRandomization", // 75
  "EfficientCanvasRandomization", // 76
  "WebGLVendorSanitize", // 77
  "WebGLVendorConstant", // 78
  "WebGLVendorRandomize", // 79
  "WebGLRendererConstant", // 80
  "IMEStyle", // 81
]);

/**
 * The channel registry. Each entry is a section module that owns a slice of the
 * targets and knows how to derive its own overrides fragment + pref map from a
 * profile. Order is the order fragments/prefs are merged (later channels win on a
 * pref-key clash — there are none by construction, asserted by the test).
 */
const CHANNELS = Object.freeze([
  { name: "navigator", cls: VentoNavigator, targets: SECTION1_TARGETS },
  { name: "screen", cls: VentoScreenWindow, targets: SECTION2_TARGETS },
  { name: "graphics", cls: VentoGraphics, targets: SECTION3_TARGETS },
  { name: "fonts", cls: VentoFonts, targets: SECTION4_TARGETS },
  { name: "audio", cls: VentoAudio, targets: SECTION5_TARGETS },
  { name: "input", cls: VentoInputDevices, targets: SECTION6_TARGETS },
  { name: "time", cls: VentoTimeLocale, targets: SECTION7_TARGETS },
  { name: "misc", cls: VentoMiscSurfaces, targets: SECTION8_TARGETS },
]);

/**
 * Dispositions for the targets that no section module owns. Every RFPTarget not
 * pinned by a channel above MUST appear here, or it is a coverage hole. See the
 * disposition vocabulary in the file header.
 */
export const COMPOSER_DISPOSITIONS = Object.freeze({
  // Behavioral channel (section 10): the RFP targets are enabled so RFP's own
  // timestamp/coordinate reduction forms the baseline; VentoBehavioralQuantizer
  // is the deterministic native-hook replacement on top (see README).
  WidgetEvents: "enabled",
  MouseEventScreenPoint: "enabled",

  // Screen geometry (section 2): make availWidth/Height report the pinned screen
  // resolution rather than a real work-area, deterministically. No value pref of
  // its own; enabling the target is the whole mechanism.
  ScreenAvailToResolution: "enabled",

  // WebGL vendor STRATEGY (section 3): Vento pins a constant (WebGLVendorConstant,
  // owned by the graphics channel). The two alternative strategies must be forced
  // OFF: "Randomize" would emit a per-machine-random string — fatal to identity —
  // and "Sanitize" would compete with the constant. Force-disabled so neither can
  // be turned on by a stale pref.
  WebGLVendorRandomize: "blocked",
  WebGLVendorSanitize: "blocked",

  // Canvas extraction GATES (section 3): these are permission/policy toggles
  // (prompt before readback, block third-party/pre-input extraction), not value
  // surfaces. Vento's model is "canvas is readable but returns deterministic
  // bytes", so we leave these at the Gecko default rather than force a behavioural
  // change. Recorded here so the decision is explicit and auditable.
  CanvasImageExtractionPrompt: "policy",
  CanvasExtractionFromThirdPartiesIsBlocked: "policy",
  CanvasExtractionBeforeUserInputIsBlocked: "policy",
});

function buildPinnedSet() {
  const pinned = new Set();
  for (const { targets } of CHANNELS) {
    for (const t of targets) {
      pinned.add(t);
    }
  }
  return pinned;
}

/**
 * The composer. Stateless w.r.t. the browser (no Services.* here) so it stays
 * engine-agnostic and unit-testable; a caller (VentoFingerprintService) is what
 * actually writes the produced pref map into Services.prefs.
 */
export class VentoFingerprintComposer {
  /**
   * Classify every RFPTarget in ALL_RFP_TARGETS and prove the checklist is
   * complete. Throws if a target is both pinned by a channel AND listed in
   * COMPOSER_DISPOSITIONS (ambiguous ownership), if a composer disposition names
   * an unknown target, or — via `missing` — if any target has no disposition.
   *
   * @returns {{pinned:string[], enabled:string[], blocked:string[],
   *   policy:string[], missing:string[], byChannel:object, total:number}}
   */
  static coverageReport() {
    const pinned = buildPinnedSet();
    const known = new Set(ALL_RFP_TARGETS);

    for (const t of Object.keys(COMPOSER_DISPOSITIONS)) {
      if (!known.has(t)) {
        throw new Error(`COMPOSER_DISPOSITIONS names unknown RFPTarget "${t}"`);
      }
      if (pinned.has(t)) {
        throw new Error(
          `RFPTarget "${t}" is both channel-pinned and composer-dispositioned`
        );
      }
    }

    const report = {
      pinned: [],
      enabled: [],
      blocked: [],
      policy: [],
      missing: [],
      byChannel: {},
      total: ALL_RFP_TARGETS.length,
    };
    for (const { name, targets } of CHANNELS) {
      report.byChannel[name] = [...targets];
    }
    for (const t of ALL_RFP_TARGETS) {
      if (pinned.has(t)) {
        report.pinned.push(t);
      } else if (t in COMPOSER_DISPOSITIONS) {
        report[COMPOSER_DISPOSITIONS[t]].push(t);
      } else {
        report.missing.push(t);
      }
    }
    return report;
  }

  /** Throws unless every RFPTarget is accounted for. */
  static assertFullCoverage() {
    const r = VentoFingerprintComposer.coverageReport();
    if (r.missing.length) {
      throw new Error(
        `deny-by-default coverage hole: ${r.missing.join(", ")} have no ` +
          `channel owner and no composer disposition`
      );
    }
    return r;
  }

  /**
   * The merged `privacy.fingerprintingProtection.overrides` value for a profile:
   * every channel's `+Target` fragment, the composer-level `+enabled` targets, and
   * a `-Target` for each `blocked` one, deduplicated and sorted so the output is a
   * deterministic function of the profile (two machines produce byte-identical
   * strings). Sorting also makes a diff in review one line.
   *
   * @param {object} profile A VentoFingerprintProfile (or export()ed object).
   * @returns {string}
   */
  static composeOverrides(profile) {
    const enable = new Set();
    const disable = new Set();

    for (const { cls } of CHANNELS) {
      const frag = cls.fromProfile(profile).overridesFragment();
      for (const token of frag.split(",")) {
        const t = token.trim();
        if (!t) {
          continue;
        }
        (t.startsWith("-") ? disable : enable).add(t.replace(/^[+-]/, ""));
      }
    }
    for (const [t, disp] of Object.entries(COMPOSER_DISPOSITIONS)) {
      if (disp === "enabled") {
        enable.add(t);
      } else if (disp === "blocked") {
        disable.add(t);
      }
    }

    const tokens = [
      ...[...enable].map(t => `+${t}`),
      ...[...disable].map(t => `-${t}`),
    ].sort();
    return tokens.join(",");
  }

  /**
   * The complete pref map to apply for a profile: the union of every channel's
   * `deterministicPrefs()`, plus the master toggle, the merged overrides string,
   * the deterministic-seed pref the native injection point reads, and the format
   * version for diagnostics. Returned as a Map so a caller can write it verbatim;
   * a duplicate pref key across channels throws (there are none by construction).
   *
   * @param {object} profile A VentoFingerprintProfile.
   * @returns {Map<string, string|number|boolean>}
   */
  static composePrefs(profile) {
    const out = new Map();
    for (const { name, cls } of CHANNELS) {
      for (const [k, v] of cls.fromProfile(profile).deterministicPrefs()) {
        if (out.has(k) && out.get(k) !== v) {
          throw new Error(
            `pref "${k}" set to conflicting values across channels ` +
              `(at ${name}: ${v} vs existing ${out.get(k)})`
          );
        }
        out.set(k, v);
      }
    }
    out.set("privacy.fingerprintingProtection", true);
    out.set(
      "privacy.fingerprintingProtection.overrides",
      VentoFingerprintComposer.composeOverrides(profile)
    );
    out.set("vento.fingerprint.seed", profile.seed);
    if (Number.isInteger(profile.version)) {
      out.set("vento.fingerprint.profile.version", profile.version);
    }
    return out;
  }
}
