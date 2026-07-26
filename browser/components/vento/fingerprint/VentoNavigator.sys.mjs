/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Navigator + HTTP client-hints — the isolated, engine-agnostic core of
 * section 1 ("Навигатор и HTTP-заголовки") of ../docs/FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data: a (partial) profile in, a
 * deterministic set of spoofed values + a pref map out.
 *
 * The section-1 surfaces, with their RFPTarget id (RFPTargets.inc), verified
 * against the tree (nsRFPService.h SPOOFED_* + Navigator.cpp + nsHttpHandler):
 *
 *   JSLocale (13)                 navigator.language / navigator.languages
 *   NavigatorAppVersion (14)      navigator.appVersion
 *   NavigatorBuildID (15)         navigator.buildID
 *   NavigatorHWConcurrency (16)   navigator.hardwareConcurrency
 *   NavigatorOscpu (17)           navigator.oscpu
 *   NavigatorPlatform (18)        navigator.platform
 *   NavigatorUserAgent (19)       navigator.userAgent (JS side)
 *   PdfjsSpoof (20)               navigator.pdfViewerEnabled / plugins / mimeTypes
 *   HttpUserAgent (25)            the HTTP `User-Agent` request header
 *   NavigatorHWConcurrencyTiered (74)  the tiered hardwareConcurrency variant
 *
 * KEY FINDING (verified against the tree). Unlike the "deny-by-default" sections
 * (6/8), section 1 is the block where Vento's goal DIVERGES from stock RFP, and
 * the divergence has a concrete, testable consequence:
 *
 *   RFP does NOT collapse the UA family to ONE cross-OS constant. It keeps the
 *   *real* OS: `nsRFPService::GetSpoofedUserAgent` builds the string from the
 *   compile-time `SPOOFED_UA_OS` macro ("Windows NT 10.0; Win64; x64" on Windows,
 *   "Macintosh; Intel Mac OS X 10.15" on macOS, "X11; Linux x86_64" elsewhere),
 *   `Navigator::GetPlatform` returns "Win32"/"MacIntel"/"Linux x86_64" per build,
 *   `GetOSCPU`/`GetAppVersion` likewise. So two RFP users on Windows vs. macOS
 *   report DIFFERENT navigator.* — the opposite of what Vento needs.
 *
 * Therefore the primary mechanism here is NOT the RFPTarget overrides fragment
 * (that would re-pin each machine to its own per-OS constant); it is the set of
 * `general.*.override` prefs that Gecko already honours in Navigator.cpp /
 * nsHttpHandler and that DO take one fleet-wide value regardless of the host OS,
 * with NO native patch:
 *   general.useragent.override   -> navigator.userAgent + the HTTP User-Agent
 *   general.appversion.override  -> navigator.appVersion
 *   general.platform.override    -> navigator.platform
 *   general.oscpu.override        -> navigator.oscpu
 *   general.buildID.override      -> navigator.buildID
 *   intl.accept_languages         -> navigator.languages + Accept-Language header
 * `deterministicPrefs()` emits exactly these. `overridesFragment()` is provided
 * for completeness (so the JS-side values also survive when the profile-wide RFP
 * master toggle is on) but the honest note is that enabling the targets alone
 * gives the per-OS constant, so the override prefs are what make the value
 * fleet-wide.
 *
 * The genuine native remainders — the few things a pref cannot pin to a POSITIVE
 * fleet-wide value — are (a) forcing hardwareConcurrency UP past the real core
 * count (the pref only clamps down, RFP hard-codes 4/8 per-OS), and (b) emitting
 * a full, UA-consistent Sec-CH-UA / navigator.userAgentData surface (Firefox does
 * not implement UA client hints at all, so there is nothing to override). Both
 * are enumerated honestly in `residualVariance()`.
 *
 * CONSISTENCY is the other half of section 1's mandate: a UA string that says
 * Windows next to a platform that says "MacIntel" is itself a fingerprint. This
 * module derives the dependent values (UA-CH platform/mobile/arch, appVersion,
 * oscpu) from the SAME os descriptor as the UA, and `consistency()` is the
 * machine-checkable assertion that they agree — so the test catches any drift.
 */

/**
 * The section-1 RFPTargets, by the exact name TextToRFPTarget expects. Kept as
 * data so `overridesFragment()`, the descriptor and the test stay in sync, and so
 * the list can be audited against RFPTargets.inc in review.
 */
export const SECTION1_TARGETS = Object.freeze([
  "JSLocale", // 13
  "NavigatorAppVersion", // 14
  "NavigatorBuildID", // 15
  "NavigatorHWConcurrency", // 16
  "NavigatorOscpu", // 17
  "NavigatorPlatform", // 18
  "NavigatorUserAgent", // 19
  "PdfjsSpoof", // 20
  "HttpUserAgent", // 25
  "NavigatorHWConcurrencyTiered", // 74
]);

/**
 * Canonical OS descriptors. Each bundles the mutually-consistent tokens that a
 * coherent navigator surface needs: the UA `os` fragment, navigator.platform,
 * navigator.oscpu, the appVersion tail, and the UA client-hints platform name +
 * a plausible platform version. Picking ONE of these (by `os` key) is what
 * guarantees UA <-> platform <-> oscpu <-> UA-CH cannot contradict each other.
 * The tokens mirror exactly what Gecko emits for that OS (nsRFPService.h
 * SPOOFED_* + Navigator.cpp), so a profile that selects "windows" is
 * byte-compatible with a real Firefox-on-Windows surface.
 */
export const OS_DESCRIPTORS = Object.freeze({
  windows: Object.freeze({
    uaOS: "Windows NT 10.0; Win64; x64",
    platform: "Win32",
    oscpu: "Windows NT 10.0; Win64; x64",
    appVersionOS: "Windows",
    chPlatform: "Windows",
    chPlatformVersion: "10.0.0",
    chArch: "x86",
    chBitness: "64",
    chMobile: false,
  }),
  macos: Object.freeze({
    uaOS: "Macintosh; Intel Mac OS X 10.15",
    platform: "MacIntel",
    oscpu: "Intel Mac OS X 10.15",
    appVersionOS: "Macintosh",
    chPlatform: "macOS",
    chPlatformVersion: "10.15.7",
    chArch: "x86",
    chBitness: "64",
    chMobile: false,
  }),
  linux: Object.freeze({
    uaOS: "X11; Linux x86_64",
    platform: "Linux x86_64",
    oscpu: "Linux x86_64",
    appVersionOS: "X11",
    chPlatform: "Linux",
    chPlatformVersion: "",
    chArch: "x86",
    chBitness: "64",
    chMobile: false,
  }),
});

/** The Gecko trail + build id RFP forces (nsRFPService.h). */
const LEGACY_UA_GECKO_TRAIL = "20100101";
const LEGACY_BUILD_ID = "20181001000000";
/** The Firefox milestone the fleet advertises. Bump in lockstep with the UA. */
const VENTO_UA_FIREFOX_VERSION = "128.0";

/**
 * The fleet-wide default for the section-1 observables. Every value MUST be
 * identical on every Vento install for the cross-machine identity guarantee to
 * hold, so these are frozen constants, NOT seed-derived (a seed-varied value here
 * would make two machines with the same profile differ). The defaults pick the
 * Windows descriptor to match the fleet-wide graphics/GPU default
 * ("Google Inc. (Intel)" / Windows) in VentoFingerprintProfile, keeping the whole
 * profile internally consistent out of the box.
 */
export const DEFAULT_NAVIGATOR_PROFILE = Object.freeze({
  os: "windows",
  firefoxVersion: VENTO_UA_FIREFOX_VERSION,

  // JSLocale(13): navigator.language(s). RFP forces "en-US"; the fleet default
  // matches so an un-configured install is byte-identical to RFP. A real profile
  // sets these to match the vento_proxy egress geo.
  language: "en-US",
  languages: Object.freeze(["en-US", "en"]),
  // The Accept-Language header value (intl.accept_languages format). Kept in sync
  // with `languages` by the constructor if not given explicitly.
  acceptLanguage: "en-US,en;q=0.5",

  // NavigatorHWConcurrency(16) / Tiered(74): RFP hard-codes 4 (8 on macOS). The
  // fleet default is 4 so it matches RFP-on-Windows; a profile may lower it (a
  // pref clamp) but raising it past the real core count is a native remainder.
  hardwareConcurrency: 4,

  // Firefox does not implement navigator.deviceMemory; kept for the standalone
  // repo / a positive UA-CH value, but exposed as null so the surface is honest.
  deviceMemory: null,

  // PdfjsSpoof(20): pdfViewerEnabled + the built-in PDF plugin shape. Firefox
  // exposes a fixed 5-entry plugin/mimeType set (all aliases of the internal PDF
  // viewer) identical on every machine, so this is already a fleet constant.
  pdfViewerEnabled: true,
});

/**
 * The fixed navigator.plugins / navigator.mimeTypes shape Firefox exposes for the
 * built-in PDF viewer (PdfjsSpoof). Identical on every machine; kept as data so
 * the module is a faithful reference for what a site observes.
 */
const PDF_PLUGIN_NAMES = Object.freeze([
  "PDF Viewer",
  "Chrome PDF Viewer",
  "Chromium PDF Viewer",
  "Microsoft Edge PDF Viewer",
  "WebKit built-in PDF",
]);
const PDF_MIME_TYPES = Object.freeze([
  {
    type: "application/pdf",
    suffixes: "pdf",
    description: "Portable Document Format",
  },
  {
    type: "text/pdf",
    suffixes: "pdf",
    description: "Portable Document Format",
  },
]);

/**
 * The section-1 surfaces bundled as a deterministic profile. Constructed from a
 * (partial) profile merged over DEFAULT_NAVIGATOR_PROFILE, so callers only
 * override what the Vento panel exposes.
 */
export class VentoNavigator {
  /**
   * @param {object} [profile] Partial overrides of DEFAULT_NAVIGATOR_PROFILE.
   *   `os` must name one of OS_DESCRIPTORS. `userAgent` may be given explicitly to
   *   override the derived string, but doing so is the caller's responsibility to
   *   keep consistent (consistency() will flag a mismatch).
   */
  constructor(profile = {}) {
    const merged = { ...DEFAULT_NAVIGATOR_PROFILE, ...profile };
    if (!Object.prototype.hasOwnProperty.call(OS_DESCRIPTORS, merged.os)) {
      throw new Error(
        `unknown os '${merged.os}', expected one of ${Object.keys(
          OS_DESCRIPTORS
        ).join(", ")}`
      );
    }
    if (
      !Number.isInteger(merged.hardwareConcurrency) ||
      merged.hardwareConcurrency <= 0
    ) {
      throw new Error("hardwareConcurrency must be a positive integer");
    }
    if (typeof merged.firefoxVersion !== "string" || !merged.firefoxVersion) {
      throw new Error("firefoxVersion must be a non-empty string");
    }
    if (!Array.isArray(merged.languages) || !merged.languages.length) {
      throw new Error("languages must be a non-empty array");
    }
    if (typeof merged.language !== "string" || !merged.language) {
      throw new Error("language must be a non-empty string");
    }
    // Keep Accept-Language in sync with `languages` unless overridden explicitly.
    if (!("acceptLanguage" in profile) && "languages" in profile) {
      merged.acceptLanguage = acceptLanguageFromList(merged.languages);
    }
    this.os = OS_DESCRIPTORS[merged.os];
    this.profile = Object.freeze({
      ...merged,
      languages: Object.freeze([...merged.languages]),
    });
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.fields`). Section 1
   * values are fleet-wide constants, not seed-derived, so this threads through any
   * explicit section-1 fields the profile carries; it does NOT consult the seed.
   * Symmetric with the other fingerprint modules.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_NAVIGATOR_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    return new VentoNavigator({ ...passthrough, ...overrides });
  }

  /** The derived User-Agent string, consistent with the selected OS descriptor. */
  userAgent() {
    if (this.profile.userAgent) {
      return this.profile.userAgent;
    }
    const v = this.profile.firefoxVersion;
    return (
      `Mozilla/5.0 (${this.os.uaOS}; rv:${v}) ` +
      `Gecko/${LEGACY_UA_GECKO_TRAIL} Firefox/${v}`
    );
  }

  /**
   * The derived Sec-CH-UA / navigator.userAgentData surface. Firefox does not
   * implement UA client hints, so this is the reference shape a native emitter (or
   * the vento_proxy) must inject if a profile wants a positive UA-CH value; it is
   * derived from the SAME os descriptor + firefoxVersion as the UA, so it can
   * never contradict navigator.userAgent.
   */
  clientHints() {
    const version = this.profile.firefoxVersion.split(".")[0];
    // The low-entropy "brands" list a UA-CH surface exposes. Firefox uses the
    // "Not?A_Brand" GREASE brand + its own; kept deterministic (no random GREASE).
    const brands = [
      { brand: "Not?A_Brand", version: "99" },
      { brand: "Firefox", version },
    ];
    return {
      brands,
      fullVersionList: [
        { brand: "Not?A_Brand", version: "99.0.0.0" },
        { brand: "Firefox", version: this.profile.firefoxVersion },
      ],
      mobile: this.os.chMobile,
      platform: this.os.chPlatform,
      platformVersion: this.os.chPlatformVersion,
      architecture: this.os.chArch,
      bitness: this.os.chBitness,
      model: "",
      wow64: false,
    };
  }

  /**
   * The flattened set of static values a site observes across all section-1
   * surfaces. Two VentoNavigator built from the same profile return a deep-equal
   * object on any machine — the CI-checkable identity property.
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      userAgent: this.userAgent(),
      appVersion: `5.0 (${this.os.appVersionOS})`,
      platform: this.os.platform,
      oscpu: this.os.oscpu,
      buildID: LEGACY_BUILD_ID,
      product: "Gecko",
      productSub: LEGACY_UA_GECKO_TRAIL,
      vendor: "",
      vendorSub: "",
      appName: "Netscape",
      appCodeName: "Mozilla",
      language: p.language,
      languages: [...p.languages],
      acceptLanguage: p.acceptLanguage,
      hardwareConcurrency: p.hardwareConcurrency,
      deviceMemory: p.deviceMemory,
      pdfViewerEnabled: p.pdfViewerEnabled,
      plugins: [...PDF_PLUGIN_NAMES],
      mimeTypes: PDF_MIME_TYPES.map(m => ({ ...m })),
      userAgentData: this.clientHints(),
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-1 target. Provided for completeness so the JS-side navigator values
   * still get spoofed when the profile-wide RFP master toggle is on. NOTE (see the
   * file header): enabling a target re-pins the value to the machine's per-OS
   * SPOOFED_* constant, so this alone does NOT give cross-OS identity — the
   * `general.*.override` prefs in `deterministicPrefs()` are what make the value
   * fleet-wide. Merge this fragment into the profile-wide overrides string.
   *
   * @returns {string} e.g. "+JSLocale,+NavigatorAppVersion,..."
   */
  overridesFragment() {
    return SECTION1_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map that pins section 1 to the fleet-wide profile value with NO
   * native patch. These are the `general.*.override` prefs Gecko already honours
   * (Navigator.cpp / nsHttpHandler) plus the locale/accept-language prefs; they
   * take one value regardless of the host OS, which is exactly what stock RFP
   * cannot do. The target-enable list is intentionally NOT folded in here (it must
   * be MERGED with the rest of the profile's overrides) — use overridesFragment().
   *
   * @returns {Map<string, string|number|boolean>}
   */
  deterministicPrefs() {
    const p = this.profile;
    return new Map([
      ["general.useragent.override", this.userAgent()],
      ["general.appversion.override", `5.0 (${this.os.appVersionOS})`],
      ["general.platform.override", this.os.platform],
      ["general.oscpu.override", this.os.oscpu],
      ["general.buildID.override", LEGACY_BUILD_ID],
      ["intl.accept_languages", p.acceptLanguage],
      // Clamp target; only lowers hardwareConcurrency (see residualVariance for
      // the up-clamp remainder). Pinning it here makes machines whose real core
      // count is >= the profile value agree.
      ["dom.maxHardwareConcurrency", p.hardwareConcurrency],
      // PdfjsSpoof(20): keep the built-in PDF viewer enabled so pdfViewerEnabled +
      // the plugin shape are the fleet constant.
      ["pdfjs.disabled", !p.pdfViewerEnabled],
    ]);
  }

  /**
   * A stable, human-auditable descriptor of everything section 1 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    return [
      `ua="${v.userAgent}"`,
      `plat=${v.platform}`,
      `oscpu="${v.oscpu}"`,
      `appver="${v.appVersion}"`,
      `build=${v.buildID}`,
      `hw=${v.hardwareConcurrency}`,
      `lang=${v.language}`,
      `langs=${v.languages.join(",")}`,
      `pdf=${+v.pdfViewerEnabled}`,
      `ch=${v.userAgentData.platform}/${v.userAgentData.mobile ? 1 : 0}`,
    ].join("|");
  }

  /**
   * The section-1 mandate's second half: the navigator surface must be internally
   * CONSISTENT — a UA that says Windows next to platform "MacIntel" is itself a
   * tell. All dependent values here derive from the one OS descriptor, so this
   * should always pass; it exists so the test (and any caller who supplies an
   * explicit `userAgent`) can machine-check that no contradiction slipped in.
   *
   * @returns {{consistent: boolean, mismatches: Array<string>}}
   */
  consistency() {
    const v = this.getSpoofedValues();
    const mismatches = [];
    // The UA OS fragment must appear verbatim in the UA string.
    if (!v.userAgent.includes(this.os.uaOS)) {
      mismatches.push(
        `userAgent does not contain os fragment '${this.os.uaOS}'`
      );
    }
    // appVersion tail must match the descriptor.
    if (v.appVersion !== `5.0 (${this.os.appVersionOS})`) {
      mismatches.push("appVersion inconsistent with os");
    }
    // The UA milestone must match the advertised Firefox version.
    if (!v.userAgent.includes(`Firefox/${this.profile.firefoxVersion}`)) {
      mismatches.push(
        "userAgent Firefox version inconsistent with firefoxVersion"
      );
    }
    // navigator.language must be the first entry of navigator.languages.
    if (v.languages[0] !== v.language) {
      mismatches.push("language is not the head of languages");
    }
    // Accept-Language must advertise the same primary language as navigator.
    if (!v.acceptLanguage.startsWith(v.language)) {
      mismatches.push("acceptLanguage primary tag inconsistent with language");
    }
    // UA-CH platform must match the OS family carried by the UA string.
    const family = this.os.chPlatform === "macOS" ? "Mac" : this.os.chPlatform;
    const uaHasFamily =
      v.userAgent.includes(family) ||
      (family === "Mac" && v.userAgent.includes("Macintosh")) ||
      (family === "Linux" && v.userAgent.includes("Linux"));
    if (!uaHasFamily) {
      mismatches.push("userAgentData.platform inconsistent with userAgent");
    }
    return { consistent: !mismatches.length, mismatches };
  }

  /**
   * Per-surface map of how section 1 is closed: the RFPTarget that carries it, the
   * mechanism (mostly "override-pref" — the fleet-wide path — with the RFPTarget
   * noted for auditing), and the exact core hook. Kept as data so ../README.md and
   * the test stay in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "navigator.userAgent (JS) + HTTP User-Agent header",
        target: "NavigatorUserAgent / HttpUserAgent",
        id: 19,
        mechanism: "override-pref",
        injectionPoint:
          "general.useragent.override is honoured by both Navigator.cpp (JS) and " +
          "nsHttpHandler::UserAgent (mUserAgentOverride, HTTP) — one value, all OS. " +
          "RFPTargets NavigatorUserAgent(19)/HttpUserAgent(25) would instead re-pin " +
          "to the per-OS SPOOFED_UA_OS macro (nsRFPService.h).",
      },
      {
        surface: "navigator.appVersion",
        target: "NavigatorAppVersion",
        id: 14,
        mechanism: "override-pref",
        injectionPoint:
          "general.appversion.override in Navigator::GetAppVersion; RFP would use " +
          "SPOOFED_APPVERSION (per-OS).",
      },
      {
        surface: "navigator.buildID",
        target: "NavigatorBuildID",
        id: 15,
        mechanism: "override-pref",
        injectionPoint:
          "general.buildID.override in Navigator::GetBuildID; RFP uses " +
          "LEGACY_BUILD_ID (already an OS-independent constant).",
      },
      {
        surface: "navigator.oscpu",
        target: "NavigatorOscpu",
        id: 17,
        mechanism: "override-pref",
        injectionPoint:
          "general.oscpu.override in Navigator::GetOscpu; RFP uses SPOOFED_OSCPU " +
          "(per-OS).",
      },
      {
        surface: "navigator.platform",
        target: "NavigatorPlatform",
        id: 18,
        mechanism: "override-pref",
        injectionPoint:
          "general.platform.override in Navigator::GetPlatform; RFP returns the " +
          "compile-time Win32/MacIntel/Linux literal (per-OS).",
      },
      {
        surface: "navigator.hardwareConcurrency",
        target: "NavigatorHWConcurrency / NavigatorHWConcurrencyTiered",
        id: 16,
        mechanism: "clamp-pref + rfp-target",
        injectionPoint:
          "dom.maxHardwareConcurrency clamps DOWN in " +
          "RuntimeService::ClampedHardwareConcurrency; RFP hard-codes 4 (8 on " +
          "macOS). A positive value above the real core count is the native " +
          "remainder (residualVariance).",
      },
      {
        surface: "navigator.language / languages + Accept-Language",
        target: "JSLocale",
        id: 13,
        mechanism: "value-pref",
        injectionPoint:
          "intl.accept_languages drives both LocaleService::GetAcceptLanguages " +
          "(the header) and navigator.languages; one value across all OS.",
      },
      {
        surface: "navigator.pdfViewerEnabled / plugins / mimeTypes",
        target: "PdfjsSpoof",
        id: 20,
        mechanism: "value-pref",
        injectionPoint:
          "pdfjs.disabled gates Navigator::PdfViewerEnabled; the plugin/mimeType " +
          "shape is a Gecko build-constant (already OS-independent).",
      },
    ];
  }

  /**
   * The variance that section 1 cannot pin to a POSITIVE fleet-wide value with a
   * pref alone — the honest native remainder. Everything else here is closed by
   * the override prefs with no native patch, so this list is short and specific.
   *
   * @returns {Array<{id:string, channel:string, whyNotPrefOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "hardware-concurrency-up-clamp",
        channel: "NavigatorHWConcurrency (value above real core count)",
        whyNotPrefOnly:
          "dom.maxHardwareConcurrency only CLAMPS DOWN (min(realCores, pref) in " +
          "RuntimeService::ClampedHardwareConcurrency), so a machine with 2 real " +
          "cores cannot report 4 via the pref. RFP's hard-coded 4/8 is per-OS, not " +
          "configurable. A fleet value guaranteed identical on a 2-core and a " +
          "16-core machine needs the native return to be the profile value.",
        normalisedBy:
          "Optional native hook: return VentoNavigator.getSpoofedValues()." +
          "hardwareConcurrency directly. Default (4, at or below most real core " +
          "counts) needs nothing beyond the pref for the common case.",
        injectionPoint:
          "RuntimeService::ClampedHardwareConcurrency — when RFP/Vento is active, " +
          "return the profile value instead of min(realCores, maxHardwareConcurrency).",
      },
      {
        id: "ua-client-hints-emitter",
        channel: "Sec-CH-UA-* headers + navigator.userAgentData",
        whyNotPrefOnly:
          "Firefox does not implement UA client hints at all — there is no header " +
          "to send and no navigator.userAgentData object, so there is nothing for " +
          "a pref to override. A site that reads getHighEntropyValues() sees " +
          "undefined on Firefox; that is already uniform, but a POSITIVE UA-CH " +
          "surface (to look like Chrome, or to volunteer consistent hints) must be " +
          "emitted natively.",
        normalisedBy:
          "Default (no UA-CH) is already fleet-uniform and needs nothing. For a " +
          "positive surface, feed clientHints() into a native emitter / the " +
          "vento_proxy request path; it is derived from the same os descriptor as " +
          "the UA so it cannot contradict it.",
        injectionPoint:
          "netwerk/protocol/http (Sec-CH-UA-* request headers) + a " +
          "navigator.userAgentData binding, seeded from clientHints(). Out of scope " +
          "for the pref-only default.",
      },
      {
        id: "cross-os-native-spoofed-values",
        channel: "navigator.* under the RFP master toggle",
        whyNotPrefOnly:
          "If the profile-wide RFP toggle is ON for its other protections, the " +
          "GetSpoofed* path wins over general.*.override, and it returns the " +
          "per-OS SPOOFED_UA_OS/PLATFORM/OSCPU constants — so a Windows and a " +
          "macOS machine diverge despite identical profiles.",
        normalisedBy:
          "Optional native hook: make nsRFPService::GetSpoofedUserAgent and " +
          "Navigator::GetPlatform/GetOscpu/GetAppVersion return the profile value " +
          "(getSpoofedValues()) instead of the compile-time SPOOFED_* macro. Not " +
          "needed when Vento relies on the override prefs (targets off).",
        injectionPoint:
          "nsRFPService::GetSpoofedUserAgent (netwerk + JS) + Navigator.cpp " +
          "GetPlatform/GetOscpu/GetAppVersion — substitute the profile value.",
      },
    ];
  }
}

/**
 * Turn a navigator.languages array into an Accept-Language header value with the
 * conventional descending q-weights (1.0 for the first, then 0.9, 0.8, ...),
 * matching how Firefox builds the header from intl.accept_languages.
 */
function acceptLanguageFromList(languages) {
  return languages
    .map((lang, i) => {
      if (i === 0) {
        return lang;
      }
      const q = Math.max(0.1, 1 - i * 0.1).toFixed(1);
      return `${lang};q=${q}`;
    })
    .join(",");
}
