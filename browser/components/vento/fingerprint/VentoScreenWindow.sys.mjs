/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Screen / Window / DPI / CSS-media Surfaces — the isolated,
 * engine-agnostic core of section 2 ("Экран, окно, DPI") of
 * FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data: a (partial) profile in, a
 * deterministic set of spoofed values + a pref map out.
 *
 * The surfaces of section 2, with their RFPTarget id (RFPTargets.inc):
 *
 *   ScreenPixelDepth (29)          screen.colorDepth / .pixelDepth
 *   ScreenRect (30)                screen.width/height / .left/.top
 *   ScreenAvailRect (31)           screen.availWidth/availHeight/availLeft/availTop
 *   WindowOuterSize (26)           window.outerWidth / .outerHeight
 *   WindowScreenXY (27)            window.screenX / .screenY
 *   WindowInnerScreenXY (28)       window.mozInnerScreenX / .mozInnerScreenY
 *   RoundWindowSize (47)           new-window sizes rounded to a stepped grid
 *   WindowDevicePixelRatio (41)    window.devicePixelRatio
 *   CSSDeviceSize (52)             @media device-width / device-height
 *   CSSColorInfo (53)              @media color / monochrome / color-gamut
 *   CSSResolution (54)             @media resolution (dppx)
 *   CSSVideoDynamicRange (57)      @media (video-)dynamic-range
 *   CSSPrefersColorScheme (6)      @media prefers-color-scheme
 *   CSSPrefersReducedMotion (7)    @media prefers-reduced-motion
 *   CSSPrefersContrast (8)         @media prefers-contrast
 *   CSSPrefersReducedTransparency(55) @media prefers-reduced-transparency
 *   CSSInvertedColors (56)         @media inverted-colors
 *   SiteSpecificZoom (61)          per-site full-zoom (leaks via resolution/DPR)
 *
 * KEY FINDING (verified against the tree — RFPTargets.inc, dom/base/nsScreen.cpp,
 * dom/base/nsGlobalWindow{Inner,Outer}.cpp, layout/style/nsMediaFeatures.cpp,
 * toolkit/components/windowwatcher/nsWindowWatcher.cpp): every one of these
 * already has spoofing code in Gecko gated behind its RFPTarget. Enabling the
 * target forces the surface to a fingerprint-safe value:
 *
 *   - The pure CSS-media features collapse to a build-constant that is by
 *     definition identical on every machine — color-gamut => srgb, resolution =>
 *     the (rounded) device-pixel-ratio, color => 8 bits/component, dynamic-range
 *     => standard, prefers-* => the deny-by-default pose (light / no-preference /
 *     false), inverted-colors => false. Like section 8 these need NO native patch
 *     of their own: they are closed by ENABLING the target.
 *   - The geometry features (ScreenRect/ScreenAvailRect/Window*Size/DevicePixel-
 *     Ratio) are the honest exception. Gecko does NOT report a fixed value for
 *     them; it reports the *letterboxed inner-window* rect (nsScreen::GetRect =>
 *     GetTopWindowInnerRectForRFP) and the *rounded* window size, and pins DPR to
 *     the whole-number ratio at the current zoom. That is deterministic only to
 *     the extent that letterboxing steps two machines onto the same grid — it is
 *     NOT a fleet-wide constant independent of the actual window. Pinning those
 *     to a *specific profile screen* (so two differently-sized real monitors
 *     report an identical screen) is the one genuine native remainder, enumerated
 *     honestly in `residualVariance()`.
 *
 * `overridesFragment()` emits the `+ScreenRect,+ScreenAvailRect,...` fragment to
 * merge into `privacy.fingerprintingProtection.overrides`, and
 * `deterministicPrefs()` pins the one genuine value pref (browser.zoom.siteSpecific
 * = false, for SiteSpecificZoom(61)). `getSpoofedValues()` is the fleet-wide shape
 * a site observes.
 *
 * OWNERSHIP NOTE: the CSS pointer/hover media features (`pointer`, `hover`,
 * `any-pointer`, `any-hover`) are driven by RFPTarget::CSSPointerCapabilities(58),
 * which is owned by the section-6 module (VentoInputDevices) because those
 * capabilities are fundamentally an input-device property (LookAndFeel pointer
 * caps). We do NOT enable that target here to avoid double ownership; we only
 * MIRROR the resulting fleet-wide values in `getSpoofedValues().cssMedia` so this
 * module is a faithful, complete picture of what a site reads. See
 * VentoInputDevices.SECTION6_TARGETS.
 */

/**
 * The section-2 RFPTargets this module OWNS, by the exact name TextToRFPTarget
 * expects. Enabling every one of these is what forces each surface to its
 * fingerprint-safe value. Kept as data so `overridesFragment()`, the descriptor
 * and the test stay in sync, and so the list can be audited against
 * RFPTargets.inc in review. CSSPointerCapabilities(58) is intentionally absent —
 * it is owned by section 6 (see the OWNERSHIP NOTE above).
 */
export const SECTION2_TARGETS = Object.freeze([
  "CSSPrefersColorScheme", // 6
  "CSSPrefersReducedMotion", // 7
  "CSSPrefersContrast", // 8
  "WindowOuterSize", // 26
  "WindowScreenXY", // 27
  "WindowInnerScreenXY", // 28
  "ScreenPixelDepth", // 29
  "ScreenRect", // 30
  "ScreenAvailRect", // 31
  "WindowDevicePixelRatio", // 41
  "RoundWindowSize", // 47
  "CSSDeviceSize", // 52
  "CSSColorInfo", // 53
  "CSSResolution", // 54
  "CSSPrefersReducedTransparency", // 55
  "CSSInvertedColors", // 56
  "CSSVideoDynamicRange", // 57
  "SiteSpecificZoom", // 61
]);

/**
 * The fleet-wide default for the section-2 observables. Every value MUST be
 * identical on every Vento install for the cross-machine identity guarantee to
 * hold — that is the whole point — so these are frozen constants, NOT derived
 * from the profile seed (a seed-varied value here would make two machines with
 * the same profile differ). The geometry defaults mirror a common 1080p desktop;
 * the CSS-media defaults mirror exactly what enabling the corresponding RFPTarget
 * produces in Gecko (nsMediaFeatures.cpp), so the module is a faithful reference
 * for what a site actually observes.
 */
export const DEFAULT_SCREENWINDOW_PROFILE = Object.freeze({
  // ScreenRect(30) / ScreenAvailRect(31): the pinned screen geometry. Gecko under
  // RFP reports the letterboxed inner-window rect; a profile that wants a screen
  // independent of the actual window feeds these via the native remainder (see
  // residualVariance). availWidth/Height equal width/height so no work-area /
  // taskbar delta leaks (that is what enabling ScreenAvailRect gives).
  screenWidth: 1920,
  screenHeight: 1080,
  screenAvailWidth: 1920,
  screenAvailHeight: 1080,

  // ScreenPixelDepth(29): 24 is the value Gecko forces (nsScreen::PixelDepth).
  colorDepth: 24,
  pixelDepth: 24,

  // WindowDevicePixelRatio(41): 1 is the whole-number ratio at 100% zoom that
  // nsRFPService::GetDevicePixelRatioAtZoom returns.
  devicePixelRatio: 1,

  // WindowOuterSize(26) / WindowScreenXY(27) / WindowInnerScreenXY(28): a
  // maximized 1080p window at the origin. Gecko rounds/zeroes these under RFP; a
  // specific profile window geometry is the optional native remainder.
  outerWidth: 1920,
  outerHeight: 1080,
  screenX: 0,
  screenY: 0,
  innerScreenX: 0,
  innerScreenY: 0,

  // CSSDeviceSize(52): @media device-width/height mirror the pinned screen.
  deviceWidth: 1920,
  deviceHeight: 1080,

  // CSSResolution(54): dppx == devicePixelRatio.
  resolution: 1,

  // CSSColorInfo(53): @media color is bits-per-component (24/3), monochrome 0.
  mediaColor: 8,
  mediaMonochrome: 0,

  // CSSColorInfo(53): color-gamut => srgb (Gecko_MediaFeatures_ColorGamut).
  colorGamut: "srgb",

  // dynamic-range is a build-constant in Gecko (Gecko_MediaFeatures_DynamicRange
  // always returns Standard); CSSVideoDynamicRange(57) forces video-dynamic-range
  // to standard too.
  dynamicRange: "standard",
  videoDynamicRange: "standard",

  // CSSPointerCapabilities(58) — OWNED BY SECTION 6, mirrored here only. Desktop
  // deny-by-default: fine mouse-type pointer that can hover.
  pointer: "fine",
  hover: "hover",
  anyPointer: "fine",
  anyHover: "hover",

  // CSSPrefersColorScheme(6): forced to light under RFP.
  prefersColorScheme: "light",

  // CSSPrefersReducedMotion(7): false (no-preference).
  prefersReducedMotion: "no-preference",

  // CSSPrefersReducedTransparency(55): false (no-preference).
  prefersReducedTransparency: "no-preference",

  // CSSPrefersContrast(8): NoPreference.
  prefersContrast: "no-preference",

  // CSSInvertedColors(56): false (none).
  invertedColors: "none",

  // SiteSpecificZoom(61): per-site zoom disabled so zoom cannot leak via
  // resolution / DPR / device-size. Full zoom pinned to 100%.
  siteSpecificZoom: false,
  zoom: 1,
});

/** The @media enumerations we validate against, so a bad profile is rejected. */
const ENUMS = Object.freeze({
  colorGamut: ["srgb", "p3", "rec2020"],
  dynamicRange: ["standard", "high"],
  videoDynamicRange: ["standard", "high"],
  pointer: ["none", "coarse", "fine"],
  anyPointer: ["none", "coarse", "fine"],
  hover: ["none", "hover"],
  anyHover: ["none", "hover"],
  prefersColorScheme: ["light", "dark"],
  prefersReducedMotion: ["no-preference", "reduce"],
  prefersReducedTransparency: ["no-preference", "reduce"],
  prefersContrast: ["no-preference", "less", "more", "custom"],
  invertedColors: ["none", "inverted"],
});

const POSITIVE_INT_KEYS = Object.freeze([
  "screenWidth",
  "screenHeight",
  "screenAvailWidth",
  "screenAvailHeight",
  "colorDepth",
  "pixelDepth",
  "outerWidth",
  "outerHeight",
  "deviceWidth",
  "deviceHeight",
  "mediaColor",
]);

/**
 * The section-2 surfaces bundled as a deterministic profile. Constructed from a
 * (partial) profile merged over DEFAULT_SCREENWINDOW_PROFILE, so callers only
 * override what the Vento panel exposes.
 */
export class VentoScreenWindow {
  /**
   * @param {object} [profile] Partial overrides of DEFAULT_SCREENWINDOW_PROFILE.
   */
  constructor(profile = {}) {
    this.profile = Object.freeze({
      ...DEFAULT_SCREENWINDOW_PROFILE,
      ...profile,
    });
    const p = this.profile;
    for (const key of POSITIVE_INT_KEYS) {
      if (!Number.isInteger(p[key]) || p[key] <= 0) {
        throw new Error(`${key} must be a positive integer`);
      }
    }
    if (!Number.isFinite(p.devicePixelRatio) || p.devicePixelRatio <= 0) {
      throw new Error("devicePixelRatio must be a positive number");
    }
    if (!Number.isFinite(p.resolution) || p.resolution <= 0) {
      throw new Error("resolution must be a positive number");
    }
    if (
      p.screenAvailWidth > p.screenWidth ||
      p.screenAvailHeight > p.screenHeight
    ) {
      throw new Error("available screen size cannot exceed the screen size");
    }
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (!allowed.includes(p[key])) {
        throw new Error(`${key} must be one of ${allowed.join(", ")}`);
      }
    }
    if (typeof p.siteSpecificZoom !== "boolean") {
      throw new Error("siteSpecificZoom must be a boolean");
    }
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.fields`). Section 2
   * values are intentionally fleet-wide constants, not seed-derived, so this only
   * threads through any explicit section-2 fields the profile carries; it does
   * NOT consult the seed. A profile that carries a nested `screen` field (the
   * shape VentoFingerprintProfile.getSpoofedValues() uses) is unpacked so the two
   * modules agree on screen geometry.
   *
   * @param {object} profile A VentoFingerprintProfile (or anything with `.fields`).
   * @param {object} [overrides] Explicit section-2 overrides that win over the profile.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_SCREENWINDOW_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    if (fields.screen && typeof fields.screen === "object") {
      const s = fields.screen;
      if (Number.isInteger(s.width)) {
        passthrough.screenWidth ??= s.width;
        passthrough.screenAvailWidth ??= s.width;
        passthrough.deviceWidth ??= s.width;
      }
      if (Number.isInteger(s.height)) {
        passthrough.screenHeight ??= s.height;
        passthrough.screenAvailHeight ??= s.height;
        passthrough.deviceHeight ??= s.height;
      }
      if (Number.isInteger(s.colorDepth)) {
        passthrough.colorDepth ??= s.colorDepth;
        passthrough.pixelDepth ??= s.colorDepth;
      }
    }
    if (Number.isFinite(fields.devicePixelRatio)) {
      passthrough.devicePixelRatio ??= fields.devicePixelRatio;
      passthrough.resolution ??= fields.devicePixelRatio;
    }
    return new VentoScreenWindow({ ...passthrough, ...overrides });
  }

  /**
   * The flattened set of static values a site observes across all section-2
   * surfaces. Two VentoScreenWindow built from the same profile return a
   * deep-equal object on any machine — that is the CI-checkable identity property
   * (test_vento_screen_window.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      screen: {
        width: p.screenWidth,
        height: p.screenHeight,
        availWidth: p.screenAvailWidth,
        availHeight: p.screenAvailHeight,
        availLeft: 0,
        availTop: 0,
        left: 0,
        top: 0,
        colorDepth: p.colorDepth,
        pixelDepth: p.pixelDepth,
      },
      devicePixelRatio: p.devicePixelRatio,
      window: {
        outerWidth: p.outerWidth,
        outerHeight: p.outerHeight,
        screenX: p.screenX,
        screenY: p.screenY,
        innerScreenX: p.innerScreenX,
        innerScreenY: p.innerScreenY,
      },
      cssMedia: {
        deviceWidth: p.deviceWidth,
        deviceHeight: p.deviceHeight,
        resolution: p.resolution,
        color: p.mediaColor,
        monochrome: p.mediaMonochrome,
        colorGamut: p.colorGamut,
        dynamicRange: p.dynamicRange,
        videoDynamicRange: p.videoDynamicRange,
        // Mirrored from section 6 (CSSPointerCapabilities) — see OWNERSHIP NOTE.
        pointer: p.pointer,
        hover: p.hover,
        anyPointer: p.anyPointer,
        anyHover: p.anyHover,
        prefersColorScheme: p.prefersColorScheme,
        prefersReducedMotion: p.prefersReducedMotion,
        prefersReducedTransparency: p.prefersReducedTransparency,
        prefersContrast: p.prefersContrast,
        invertedColors: p.invertedColors,
      },
      siteSpecificZoom: p.siteSpecificZoom,
      zoom: p.zoom,
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-2 target this module owns. nsRFPService::CreateOverridesFromText
   * parses this comma-separated `+Target` list and each enabled target forces its
   * surface to the fingerprint-safe value reflected in
   * DEFAULT_SCREENWINDOW_PROFILE. Merge this fragment into the profile-wide
   * overrides string (the master privacy.fingerprintingProtection toggle is owned
   * by the top-level profile applier, not this sub-module).
   *
   * @returns {string} e.g. "+CSSPrefersColorScheme,+WindowOuterSize,..."
   */
  overridesFragment() {
    return SECTION2_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the section-2 knobs that are genuinely pref-controllable
   * (i.e. carry a real value, not just a target toggle). Pref names verified
   * against StaticPrefList.yaml. The target-enable list is intentionally NOT
   * folded in here as a single pref write, because it must be MERGED with the
   * rest of the profile's overrides fragment rather than overwrite it — use
   * `overridesFragment()` for that.
   *
   * @returns {Map<string, boolean>}
   */
  deterministicPrefs() {
    const p = this.profile;
    return new Map([
      // SiteSpecificZoom(61): disable per-site zoom so a remembered zoom level
      // cannot leak through resolution / device-pixel-ratio / device-size.
      ["browser.zoom.siteSpecific", p.siteSpecificZoom],
    ]);
  }

  /**
   * A stable, human-auditable descriptor of everything section 2 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    const m = v.cssMedia;
    return [
      `screen=${v.screen.width}x${v.screen.height}@${v.screen.colorDepth}`,
      `avail=${v.screen.availWidth}x${v.screen.availHeight}`,
      `dpr=${v.devicePixelRatio}`,
      `outer=${v.window.outerWidth}x${v.window.outerHeight}`,
      `xy=${v.window.screenX},${v.window.screenY}`,
      `dev=${m.deviceWidth}x${m.deviceHeight}`,
      `res=${m.resolution}`,
      `gamut=${m.colorGamut}`,
      `dr=${m.dynamicRange}/${m.videoDynamicRange}`,
      `ptr=${m.pointer}/${m.hover}`,
      `scheme=${m.prefersColorScheme}`,
      `rm=${m.prefersReducedMotion}`,
      `rt=${m.prefersReducedTransparency}`,
      `contrast=${m.prefersContrast}`,
      `inv=${m.invertedColors}`,
      `ssz=${+v.siteSpecificZoom}`,
    ].join("|");
  }

  /**
   * Per-surface map of how section 2 is closed: the RFPTarget that carries it, the
   * mechanism, and the exact core hook for auditing. Kept as data so ../README.md
   * and the test stay in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "screen.colorDepth / pixelDepth",
        target: "ScreenPixelDepth",
        id: 29,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsScreen.cpp nsScreen::PixelDepth — returns 24 under the target.",
      },
      {
        surface: "screen.width/height/left/top",
        target: "ScreenRect",
        id: 30,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsScreen.cpp nsScreen::GetRect — returns the letterboxed " +
          "inner-window rect (GetTopWindowInnerRectForRFP) under the target.",
      },
      {
        surface: "screen.availWidth/availHeight/availLeft/availTop",
        target: "ScreenAvailRect",
        id: 31,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsScreen.cpp nsScreen::GetAvailRect — returns the letterboxed " +
          "inner-window rect under the target.",
      },
      {
        surface: "window.outerWidth / outerHeight",
        target: "WindowOuterSize",
        id: 26,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsGlobalWindowOuter.cpp GetOuterSize — reports inner size " +
          "(no chrome delta) under the target.",
      },
      {
        surface: "window.screenX / screenY",
        target: "WindowScreenXY",
        id: 27,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsGlobalWindowOuter.cpp GetScreenX/Y — zeroed under the target.",
      },
      {
        surface: "window.mozInnerScreenX / mozInnerScreenY",
        target: "WindowInnerScreenXY",
        id: 28,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsGlobalWindowOuter.cpp GetMozInnerScreenX/Y — zeroed under the target.",
      },
      {
        surface: "new-window size rounding",
        target: "RoundWindowSize",
        id: 47,
        mechanism: "rfp-target",
        injectionPoint:
          "toolkit/components/windowwatcher/nsWindowWatcher.cpp — new windows " +
          "rounded to a stepped grid (CalcRoundedWindowSizeForResistingFingerprinting).",
      },
      {
        surface: "window.devicePixelRatio",
        target: "WindowDevicePixelRatio",
        id: 41,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/nsGlobalWindowInner.cpp GetDevicePixelRatio — " +
          "nsRFPService::GetDevicePixelRatioAtZoom (whole-number ratio) under the target.",
      },
      {
        surface: "@media device-width / device-height",
        target: "CSSDeviceSize",
        id: 52,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp GetDeviceSize — visible area under the target.",
      },
      {
        surface: "@media color / monochrome / color-gamut",
        target: "CSSColorInfo",
        id: 53,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_{GetColorDepth," +
          "ColorGamut} — 24bpp / srgb under the target.",
      },
      {
        surface: "@media resolution",
        target: "CSSResolution",
        id: 54,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_GetResolution — " +
          "device-pixel-ratio-at-zoom under the target.",
      },
      {
        surface: "@media (video-)dynamic-range",
        target: "CSSVideoDynamicRange",
        id: 57,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_VideoDynamicRange " +
          "— standard under the target (dynamic-range is already a build-constant).",
      },
      {
        surface: "@media prefers-color-scheme",
        target: "CSSPrefersColorScheme",
        id: 6,
        mechanism: "rfp-target",
        injectionPoint:
          "Document::PreferredColorScheme / PreferenceSheet — light under the target.",
      },
      {
        surface: "@media prefers-reduced-motion",
        target: "CSSPrefersReducedMotion",
        id: 7,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_PrefersReducedMotion " +
          "— false under the target.",
      },
      {
        surface: "@media prefers-contrast",
        target: "CSSPrefersContrast",
        id: 8,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_PrefersContrast " +
          "— no-preference under the target.",
      },
      {
        surface: "@media prefers-reduced-transparency",
        target: "CSSPrefersReducedTransparency",
        id: 55,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_PrefersReducedTransparency " +
          "— false under the target.",
      },
      {
        surface: "@media inverted-colors",
        target: "CSSInvertedColors",
        id: 56,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp Gecko_MediaFeatures_InvertedColors " +
          "— false under the target.",
      },
      {
        surface: "per-site full zoom",
        target: "SiteSpecificZoom",
        id: 61,
        mechanism: "rfp-target + pref",
        injectionPoint:
          "dom/html/ImageDocument.cpp + full-zoom path; also " +
          "browser.zoom.siteSpecific=false (deterministicPrefs).",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-2 targets does NOT by itself remove.
   * The pure CSS-media features already collapse to a build-constant, so this list
   * is the geometry remainder: enabling ScreenRect/ScreenAvailRect/Window-size/DPR
   * reports the LETTERBOXED INNER-WINDOW rect (a function of the actual window),
   * not a fixed profile screen. Pinning the observables to a *positive* profile
   * value that is identical across two differently-sized real monitors needs a
   * small native return-value swap. Kept honest and as data, mirroring the other
   * modules.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "screen-geometry-positive-value",
        channel: "ScreenRect(30) / ScreenAvailRect(31)",
        whyNotTargetOnly:
          "Enabling the targets makes screen.width/height/avail* report the " +
          "letterboxed inner-window rect (nsScreen::GetRect => " +
          "GetTopWindowInnerRectForRFP), which tracks the actual window size. Two " +
          "machines with differently-sized windows therefore report different " +
          "screens; a screen fixed to the PROFILE value regardless of window size " +
          "cannot come from a pref.",
        normalisedBy:
          "The letterboxed default is already deterministic for a same-window " +
          "fleet and needs nothing. A positive fixed screen is an optional native " +
          "return-value swap.",
        injectionPoint:
          "dom/base/nsScreen.cpp nsScreen::GetRect / GetAvailRect — when RFP is " +
          "active return VentoScreenWindow.getSpoofedValues().screen instead of " +
          "the inner-window rect.",
      },
      {
        id: "device-pixel-ratio-positive-value",
        channel: "WindowDevicePixelRatio(41) / CSSResolution(54)",
        whyNotTargetOnly:
          "Enabling the target pins DPR to the whole-number ratio at the current " +
          "zoom (nsRFPService::GetDevicePixelRatioAtZoom), i.e. 1 on a standard " +
          "display. A profile that wants a specific non-1 DPR (e.g. a HiDPI " +
          "identity) identical across machines needs to override that return.",
        normalisedBy:
          "DPR=1 needs nothing (it is the fleet default). A positive non-1 DPR is " +
          "an optional native hook.",
        injectionPoint:
          "toolkit/components/resistfingerprinting/nsRFPService.cpp " +
          "GetDevicePixelRatioAtZoom — return VentoScreenWindow.getSpoofedValues()." +
          "devicePixelRatio when a positive value is configured.",
      },
      {
        id: "window-geometry-positive-value",
        channel:
          "WindowOuterSize(26) / WindowScreenXY(27) / WindowInnerScreenXY(28)",
        whyNotTargetOnly:
          "Enabling the targets rounds/zeroes the window geometry (outer size => " +
          "inner size, screenX/Y => 0), which still tracks the real inner size. A " +
          "specific profile window size/position identical across machines is not " +
          "pref-expressible.",
        normalisedBy:
          "The rounded/zeroed default is deterministic for a same-window fleet and " +
          "needs nothing. A positive fixed window geometry is an optional native hook.",
        injectionPoint:
          "dom/base/nsGlobalWindowOuter.cpp GetOuterSize / GetScreenX/Y / " +
          "GetMozInnerScreenX/Y — substitute VentoScreenWindow.getSpoofedValues()." +
          "window when a positive value is configured.",
      },
    ];
  }
}
