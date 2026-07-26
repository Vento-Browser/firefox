/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Fonts — the isolated, engine-agnostic core of section 4 ("Шрифты") of
 * FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data: a (partial) profile in, a
 * deterministic font list + a pref/overrides map out.
 *
 * Section 4 has two very different halves, and this module is honest about the
 * gap between them (see the research doc: list = Средняя, metrics = Высокая):
 *
 *   A) The available-font LIST — enumerated by a site through text-measurement
 *      probes, `@font-face` local() sniffing, or `document.fonts`. This is the
 *      high-signal, tractable half. Firefox already knows how to CLAMP the font
 *      set: the RFPTargets FontVisibilityBaseSystem(43), FontVisibilityLangPack(44)
 *      and FontVisibilityRestrictGenerics(62), plus UseHardcodedFontSubstitutes(69)
 *      and the `layout.css.font-visibility` pref, collapse the visible families to
 *      the "base system" tier and hide every user-installed font — killing the
 *      biggest source of entropy (which extra fonts a user has installed).
 *
 *   B) The glyph render METRICS — advance widths, kerning, hinting, and (on
 *      macOS) `-moz-osx-font-smoothing` (DOMStyleOsxFontSmoothing(51)). These are
 *      OS/rasteriser-dependent and stitch directly into the canvas-text problem
 *      (section 3). They CANNOT be made byte-identical across machines by prefs
 *      alone; that needs bundled profile fonts + a unified software rasteriser.
 *      This module pins what it can (osx-font-smoothing) and enumerates the rest
 *      honestly in `residualVariance()`.
 *
 * KEY FINDING (verified against the tree): the base-system clamp is real but it is
 * PER-OS. `gfxPlatformFontList::GetVisibilityForFamily` classifies a family as
 * `FontVisibility::Base` iff it appears in that platform's hard-coded base list
 * (`StandardFonts-win10.inc` / `StandardFonts-macos.inc` / `-linux.inc`, applied
 * in `gfxDWriteFontList` / `gfxMacPlatformFontList` / `gfxFT2FontList`). So even
 * with the targets enabled, a Windows box and a macOS box report DIFFERENT base
 * lists. Enabling the targets removes the user-installed-font entropy on each
 * machine (the big win), but a *cross-OS-identical* list requires one native
 * remainder: classify visibility against the profile whitelist instead of the OS
 * base list. `getSpoofedValues().fonts` is exactly the fleet-wide list a site must
 * observe; the native hook is enumerated in `residualVariance()`.
 */

/**
 * The section-4 RFPTargets, by the exact name TextToRFPTarget expects. Enabling
 * every one of these is what clamps font visibility to the base tier and forces
 * the hard-coded substitute mapping. Kept as data so `overridesFragment()`, the
 * descriptor and the test stay in sync, and so the list can be audited against
 * RFPTargets.inc in review.
 */
export const SECTION4_TARGETS = Object.freeze([
  "FontVisibilityBaseSystem", // 43
  "FontVisibilityLangPack", // 44
  "FontVisibilityRestrictGenerics", // 62
  "UseHardcodedFontSubstitutes", // 69
  "DOMStyleOsxFontSmoothing", // 51
]);

/**
 * `layout.css.font-visibility` levels (StaticPrefList.yaml):
 *   1 - only base system fonts
 *   2 - also fonts from optional language packs
 *   3 - also user-installed fonts (Firefox default)
 * Vento pins level 1 so the visible set can never include a user-installed font.
 */
export const FONT_VISIBILITY = Object.freeze({
  BASE: 1,
  LANGPACK: 2,
  USER: 3,
});

/**
 * The fleet-wide default font list — a curated subset of the Windows 10 base
 * families (see gfx/thebes/StandardFonts-win10.inc). Every Vento install MUST
 * report THIS list, regardless of the real OS, for the cross-machine identity
 * guarantee to hold — so it is a frozen constant, NOT derived from the seed (a
 * seed-varied list would make two machines with the same profile differ). It
 * matches the Windows persona the rest of the default profile advertises
 * (VentoFingerprintProfile.getSpoofedValues() ships a Win32/Windows UA), so a
 * site cross-checking the UA against the font list sees a consistent machine.
 */
export const DEFAULT_FONTS = Object.freeze([
  "Arial",
  "Arial Black",
  "Calibri",
  "Cambria",
  "Cambria Math",
  "Candara",
  "Comic Sans MS",
  "Consolas",
  "Constantia",
  "Corbel",
  "Courier New",
  "Ebrima",
  "Franklin Gothic Medium",
  "Gabriola",
  "Gadugi",
  "Georgia",
  "Impact",
  "Lucida Console",
  "Lucida Sans Unicode",
  "Marlett",
  "Microsoft Sans Serif",
  "MS Gothic",
  "MV Boli",
  "Palatino Linotype",
  "Segoe Print",
  "Segoe Script",
  "Segoe UI",
  "Segoe UI Emoji",
  "Segoe UI Historic",
  "Segoe UI Symbol",
  "SimSun",
  "Sylfaen",
  "Symbol",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
  "Webdings",
  "Wingdings",
]);

/**
 * The fleet-wide default for the section-4 observables. Frozen constants for the
 * same reason as DEFAULT_FONTS: identical on every machine by construction.
 */
export const DEFAULT_FONT_PROFILE = Object.freeze({
  // The whitelist every machine reports (see DEFAULT_FONTS).
  fonts: DEFAULT_FONTS,

  // FontVisibilityBaseSystem(43)/LangPack(44): clamp to the base tier so no
  // user-installed font is ever enumerable. Pinned via layout.css.font-visibility.
  fontVisibilityLevel: FONT_VISIBILITY.BASE,

  // UseHardcodedFontSubstitutes(69): resolve generic families (serif/sans-serif/
  // monospace/...) through the fixed substitute table rather than the OS default,
  // so a <generic-family> can't leak the platform's real default face.
  useHardcodedFontSubstitutes: true,

  // FontVisibilityRestrictGenerics(62): apply the visibility clamp even when
  // resolving a CSS <generic-family>, so generics can't reach a hidden family.
  restrictGenerics: true,

  // DOMStyleOsxFontSmoothing(51): `-moz-osx-font-smoothing` is a macOS tell (it
  // reflects the platform's grayscale/subpixel AA). Hidden/normalised so the
  // computed style is identical on every OS.
  osxFontSmoothingHidden: true,
});

/**
 * Section 4 bundled as a deterministic profile. Constructed from a (partial)
 * profile merged over DEFAULT_FONT_PROFILE, so callers only override what the
 * Vento panel exposes (in practice: the font whitelist).
 */
export class VentoFonts {
  /**
   * @param {object} [profile] Partial overrides of DEFAULT_FONT_PROFILE.
   */
  constructor(profile = {}) {
    const merged = { ...DEFAULT_FONT_PROFILE, ...profile };
    if (!Array.isArray(merged.fonts)) {
      throw new Error("fonts must be an array");
    }
    if (merged.fonts.some(f => typeof f !== "string" || !f.length)) {
      throw new Error("every font must be a non-empty string");
    }
    const level = merged.fontVisibilityLevel;
    if (level !== 1 && level !== 2 && level !== 3) {
      throw new Error("fontVisibilityLevel must be 1, 2 or 3");
    }
    // Normalise the list to a stable, de-duplicated, sorted order so two profiles
    // that carry the same set of families — in any input order — are byte-for-byte
    // identical everywhere they are observed.
    merged.fonts = Object.freeze(
      Array.from(new Set(merged.fonts)).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    );
    this.profile = Object.freeze(merged);
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.fields`). The font
   * whitelist is a first-class profile field (VentoFingerprintProfile already
   * carries `fields.fonts`), so this threads it through together with any explicit
   * section-4 fields; unspecified fields keep the fleet-wide default.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_FONT_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    return new VentoFonts({ ...passthrough, ...overrides });
  }

  /**
   * The flattened set of static values a site observes across section 4. Two
   * VentoFonts built from the same profile return a deep-equal object on any
   * machine — that is the CI-checkable identity property (test_vento_fonts.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      fonts: p.fonts.slice(),
      fontVisibilityLevel: p.fontVisibilityLevel,
      useHardcodedFontSubstitutes: p.useHardcodedFontSubstitutes,
      restrictGenerics: p.restrictGenerics,
      osxFontSmoothingHidden: p.osxFontSmoothingHidden,
    };
  }

  /** True iff a family name is in the profile whitelist (case-insensitive). */
  isFontVisible(family) {
    const needle = String(family).toLowerCase();
    return this.profile.fonts.some(f => f.toLowerCase() === needle);
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-4 target. This is the mechanism that clamps the font set without a
   * native patch: nsRFPService::CreateOverridesFromText parses this comma-separated
   * `+Target` list, and the enabled visibility targets collapse the enumerable
   * families to the base tier. Merge this fragment into the profile-wide overrides
   * string (the master privacy.fingerprintingProtection toggle is owned by the
   * top-level profile applier, not this sub-module).
   *
   * @returns {string} e.g. "+FontVisibilityBaseSystem,+FontVisibilityLangPack,..."
   */
  overridesFragment() {
    return SECTION4_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the section-4 knobs that carry a real value (not just a
   * target toggle). Pref name verified against StaticPrefList.yaml. The
   * target-enable list is intentionally NOT folded in here, because it must be
   * MERGED with the rest of the profile's overrides fragment rather than overwrite
   * it — use `overridesFragment()` for that.
   *
   * @returns {Map<string, number>}
   */
  deterministicPrefs() {
    return new Map([
      // FontVisibilityBaseSystem/LangPack(43/44): hard-pin the visible tier to
      // "base system fonts only" so a user-installed font is never enumerable.
      ["layout.css.font-visibility", this.profile.fontVisibilityLevel],
    ]);
  }

  /**
   * A stable, human-auditable descriptor of everything section 4 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    return [
      `nfonts=${v.fonts.length}`,
      `vis=${v.fontVisibilityLevel}`,
      `hardcoded=${+v.useHardcodedFontSubstitutes}`,
      `restrictGenerics=${+v.restrictGenerics}`,
      `osxsmooth=${+v.osxFontSmoothingHidden}`,
      `hash=${fnv1a(v.fonts.join(" "))}`,
    ].join("|");
  }

  /**
   * Per-surface map of how section 4 is closed: the RFPTarget that carries it, the
   * mechanism, and the exact core hook for auditing. Kept as data so ../README.md
   * and the test stay in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "Available font list (base-system clamp)",
        target: "FontVisibilityBaseSystem / FontVisibilityLangPack",
        id: 43,
        mechanism: "rfp-target + pref",
        injectionPoint:
          "gfx/thebes/gfxPlatformFontList.cpp IsVisibleToCSS / GetVisibilityForFamily " +
          "— visibility is clamped to FontVisibility::Base under these targets; also " +
          "pinnable via layout.css.font-visibility (deterministicPrefs).",
      },
      {
        surface: "Generic family resolution (<generic-family>)",
        target: "FontVisibilityRestrictGenerics",
        id: 62,
        mechanism: "rfp-target",
        injectionPoint:
          "gfx/thebes/gfxPlatformFontList.cpp (~L1773/L2264) — the visibility clamp " +
          "is applied when resolving a CSS generic, so generics can't reach a hidden " +
          "family.",
      },
      {
        surface: "Generic -> concrete font substitution",
        target: "UseHardcodedFontSubstitutes",
        id: 69,
        mechanism: "rfp-target",
        injectionPoint:
          "gfx/thebes font substitution — resolve serif/sans-serif/monospace through " +
          "the fixed substitute table instead of the OS default face.",
      },
      {
        surface: "-moz-osx-font-smoothing computed style",
        target: "DOMStyleOsxFontSmoothing",
        id: 51,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style — `-moz-osx-font-smoothing` is normalised under the target so " +
          "the macOS AA mode does not leak through getComputedStyle.",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-4 targets does NOT by itself remove.
   * Unlike section 8, the base-system clamp is genuinely PER-OS and glyph metrics
   * are hardware-bound, so this list is load-bearing, not merely optional polish —
   * it is the honest boundary between "what prefs buy" and "what still needs a
   * native patch / a bundled-font unified rasteriser". Kept as data, mirroring the
   * network module.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "font-list-per-os-base-set",
        channel: "Available font list (cross-OS identity)",
        whyNotTargetOnly:
          "Enabling the visibility targets clamps each machine to its OWN base tier, " +
          "but the base list is platform-hard-coded (StandardFonts-win10.inc vs " +
          "-macos.inc vs -linux.inc), so a Windows and a macOS box still report " +
          "different families. Removing the user-installed entropy is done; making " +
          "the list byte-identical across OSes is not.",
        normalisedBy:
          "Native: classify visibility against getSpoofedValues().fonts (the profile " +
          "whitelist) instead of the OS base list — a family is Base iff it is in the " +
          "whitelist. This is the section-4 'задать список из профиля' remainder.",
        injectionPoint:
          "gfxPlatformFontList::GetVisibilityForFamily — when RFP is active, return " +
          "FontVisibility::Base iff VentoFonts.isFontVisible(name), else Hidden; and " +
          "have the family enumerator report exactly the whitelist.",
      },
      {
        id: "glyph-render-metrics",
        channel: "Glyph metrics: advance widths / kerning / hinting",
        whyNotTargetOnly:
          "Text-measurement (TextMetrics.width, per-glyph advances) and hinting depend " +
          "on the OS rasteriser and installed font binaries, not on a pref. Two " +
          "machines with the same whitelist name but different font files or " +
          "rasterisers measure text differently. This is the same root cause as the " +
          "canvas-text channel (section 3) and is High difficulty by design.",
        normalisedBy:
          "Not closeable by prefs. Requires bundling the profile's font BINARIES with " +
          "the browser and forcing a deterministic software rasteriser (shared with " +
          "the canvas-text PoC) so advances/hinting are build-constant across machines.",
        injectionPoint:
          "gfx/thebes shaping + gfx/2d text path (shared with the section-3 canvas-text " +
          "unified-rasteriser PoC); out of scope for the list half, tracked with п.3.",
      },
      {
        id: "osx-font-smoothing-positive-value",
        channel: "DOMStyleOsxFontSmoothing (positive value only)",
        whyNotTargetOnly:
          "Enabling the target normalises `-moz-osx-font-smoothing` (deterministic). A " +
          "profile that wants to POSE as a specific macOS smoothing mode rather than " +
          "the normalised default would need a style hook.",
        normalisedBy:
          "Default (normalised) needs nothing; a positive posed value is an optional " +
          "native hook.",
        injectionPoint:
          "layout/style computed-value path for -moz-osx-font-smoothing.",
      },
    ];
  }
}

/**
 * fnv1a — small deterministic 32-bit string hash (hex). Portable and trivially
 * re-implementable in C++/Rust; used only to fingerprint the font list into the
 * descriptor so a drift shows up as one changed token in the test.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
