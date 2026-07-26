/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Time / Timers / TZ / Locale / Math — the isolated, engine-agnostic core
 * of section 7 ("Время, таймеры, дата") of FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data + arithmetic: a (partial)
 * profile in, a deterministic set of spoofed values + a pref map out.
 *
 * The four surfaces of section 7, with their RFPTarget id (RFPTargets.inc):
 *
 *   JSDateTimeUTC (22)   Date / Intl time zone. RFP forces a single zone
 *                        ("Atlantic/Reykjavik", UTC+0 no-DST) via
 *                        nsRFPService::GetSpoofedJSTimeZone(). For a *profile*
 *                        identity we want the profile's zone, not a global
 *                        constant — one native return-value swap.
 *   JSLocale (13) /      ICU default locale for Intl/Date formatting. RFP forces
 *   JSLocalePrompt (67)  "en-US" via nsRFPService::GetSpoofedJSLocale(). Same
 *                        story: swap the return value for the profile locale.
 *   JSMathFdlibm (23)    sin/cos/... routed through the bundled fdlibm so results
 *                        are bit-identical on every platform. RFP already does
 *                        this; it is a build-constant, so — like section 8 — it
 *                        needs NO native patch, only ENABLING the target.
 *   ReduceTimerPrecision High-resolution clocks (performance.now, Date.now,
 *   (35)                 event.timeStamp). RFP floors to a resolution and then
 *                        JITTERS by a per-process RANDOM midpoint seed
 *                        (nsRFPService::RandomMidpoint). That random seed is the
 *                        one thing that differs across machines with the same
 *                        profile, so it is what section 7 has to pin.
 *
 * HOW EACH SURFACE IS CLOSED (three shapes, mirroring the other modules):
 *
 *   - Math (fdlibm): pure "enable the RFPTarget" — a build constant, identical
 *     everywhere for free. Emitted by `overridesFragment()`. Zero native work.
 *   - Timers: enabling ReduceTimerPrecision floors the clock (good) but the
 *     default jitter uses a random per-process seed (bad for cross-machine
 *     identity). The zero-native-work choice is to PIN the resolution and turn
 *     the jitter OFF (`deterministicPrefs()` sets
 *     privacy.resistFingerprinting.reduceTimerPrecision.jitter=false): a plain
 *     floor is already identical on every machine. If a profile WANTS jitter on
 *     (harder against timing attacks) it must become deterministic — the exact
 *     seed-keyed midpoint math the native side has to reproduce is provided here
 *     as the reference `quantizeTimerUs()` / `timerMidpointSeedHex()`, and the
 *     one native hook is enumerated in `residualVariance()`.
 *   - TZ / locale: enabling the target gives a *global constant* (Reykjavik /
 *     en-US), which is already identical across machines — so if the profile is
 *     content with that, it is free. A profile that wants its OWN zone/locale
 *     (which it must, to match the vento_proxy egress geo — see the research
 *     doc) needs the two one-line native return-value swaps enumerated in
 *     `residualVariance()`; everything a site then observes is still a
 *     deterministic function of the profile.
 */

import { cyrb128 } from "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs";

/**
 * The section-7 RFPTargets, by the exact name TextToRFPTarget expects. Kept as
 * data so `overridesFragment()`, the descriptor and the test stay in sync and so
 * the list can be audited against RFPTargets.inc in review. Note the difference
 * in intent from section 8: enabling JSMathFdlibm gives a build-constant we want
 * verbatim, while enabling JSDateTimeUTC / JSLocale gives a *global* constant we
 * then OVERRIDE per-profile at the native return-value hook (residualVariance).
 */
export const SECTION7_TARGETS = Object.freeze([
  "JSDateTimeUTC", // 22
  "JSLocale", // 13
  "JSLocalePrompt", // 67
  "JSMathFdlibm", // 23
  "ReduceTimerPrecision", // 35
]);

/**
 * The fleet-wide default for the section-7 observables. TZ and locale default to
 * exactly what RFP forces today (so an un-configured Vento install is byte-for-
 * byte identical to RFP and to every other Vento install), and the timer knobs
 * default to the deterministic floor-only choice. Every value MUST be a plain
 * datum (never seed-derived) so two machines with the same profile agree — the
 * only seed-derived quantity in this module is the OPTIONAL jitter midpoint seed,
 * which is a deterministic function of the shared master seed and therefore still
 * identical across machines.
 */
export const DEFAULT_TIME_LOCALE_PROFILE = Object.freeze({
  // JSDateTimeUTC(22): the IANA zone the engine reports. RFP's own constant is
  // "Atlantic/Reykjavik" (UTC+0, no DST); we default to it so "do nothing" ==
  // "same as RFP". A real profile overrides this to match its proxy geo.
  timezone: "Atlantic/Reykjavik",

  // JSLocale(13)/JSLocalePrompt(67): ICU default locale. RFP's constant is
  // "en-US"; same defaulting rationale as timezone.
  locale: "en-US",

  // JSMathFdlibm(23): route transcendental math through bundled fdlibm so
  // results are bit-identical across platforms. Always on — turning it off would
  // reintroduce a platform tell, so this is not really a knob, just documented.
  mathFdlibm: true,

  // ReduceTimerPrecision(35): clock resolution in microseconds. 1000us (1ms) is
  // the Firefox RFP default; pinned so every machine floors identically.
  timerResolutionUs: 1000,

  // Jitter OFF by default => a plain floor to the resolution, which is already
  // deterministic across machines. Set true only together with a native
  // deterministic-midpoint hook (see residualVariance) — a random-seeded jitter
  // would break the cross-machine identity guarantee.
  timerJitter: false,
});

// Little-endian read of an 8-byte slice of a hex string as a BigInt uint64.
function u64FromHexLE(hex, byteOffset) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    const byte = parseInt(hex.substr((byteOffset + i) * 2, 2), 16);
    v = (v << 8n) | BigInt(byte);
  }
  return v;
}

const MASK64 = (1n << 64n) - 1n;

/**
 * xorshift128+ — a BigInt reimplementation of mfbt/XorShift128PlusRNG.h, needed
 * so the reference `quantizeTimerUs()` reproduces nsRFPService::RandomMidpoint
 * bit-for-bit. next() matches the C++ exactly (same shifts, same wraparound).
 */
class XorShift128Plus {
  constructor(s0, s1) {
    this.s0 = s0 & MASK64;
    this.s1 = s1 & MASK64;
  }
  next() {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= (s1 << 23n) & MASK64;
    this.s1 = (s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n)) & MASK64;
    return (this.s1 + s0) & MASK64;
  }
}

/**
 * The section-7 surfaces bundled as a deterministic profile. Constructed from a
 * master seed (for the optional deterministic jitter midpoint) plus a partial
 * profile merged over DEFAULT_TIME_LOCALE_PROFILE, so callers only override what
 * the Vento panel exposes.
 */
export class VentoTimeLocale {
  /**
   * @param {object} opts
   * @param {string} opts.seed  Master secret string (same one the rest of the
   *   fingerprint modules use). Only consulted to derive the jitter midpoint
   *   seed; TZ/locale/resolution are plain data, never seed-derived.
   * @param {object} [opts.profile]  Partial overrides of
   *   DEFAULT_TIME_LOCALE_PROFILE.
   */
  constructor({ seed, profile = {} } = {}) {
    if (typeof seed !== "string" || !seed.length) {
      throw new Error("VentoTimeLocale requires a non-empty string seed");
    }
    this.seed = seed;
    this.profile = Object.freeze({
      ...DEFAULT_TIME_LOCALE_PROFILE,
      ...profile,
    });
    const p = this.profile;
    if (typeof p.timezone !== "string" || !p.timezone.length) {
      throw new Error("timezone must be a non-empty string");
    }
    if (typeof p.locale !== "string" || !p.locale.length) {
      throw new Error("locale must be a non-empty string");
    }
    if (!Number.isInteger(p.timerResolutionUs) || p.timerResolutionUs <= 0) {
      throw new Error("timerResolutionUs must be a positive integer");
    }
    if (typeof p.timerJitter !== "boolean") {
      throw new Error("timerJitter must be a boolean");
    }
  }

  /**
   * Build from a VentoFingerprintProfile (seed + `.fields`).
   *
   * @param {object} profile  A VentoFingerprintProfile (uses `.seed`/`.fields`).
   * @param {object} [overrides]  Explicit section-7 overrides applied last.
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_TIME_LOCALE_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    return new VentoTimeLocale({
      seed: profile.seed,
      profile: { ...passthrough, ...overrides },
    });
  }

  /**
   * The 16-byte (128-bit) hex seed that replaces nsRFPService' random
   * sSecretMidpointSeed when deterministic jitter is enabled. A deterministic
   * function of the master seed, so two machines with the same profile derive the
   * same midpoint stream. Unused when timerJitter is false (the default).
   */
  timerMidpointSeedHex() {
    return cyrb128(`${this.seed} timer-midpoint-seed`)
      .map(w => (w >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  /**
   * The reference implementation of the clock reduction the native side must
   * match: floor to the resolution, then — only if jitter is on — add the
   * seed-keyed midpoint exactly the way nsRFPService::ReduceTimePrecisionImpl +
   * RandomMidpoint do (xorshift128+ seeded from contextMixin ^ seedLo and
   * clampedTime ^ seedHi, midpoint = next() % resolution). With jitter off this
   * is a plain floor, so it is trivially identical across machines; with jitter
   * on it is identical across machines because the midpoint seed is derived from
   * the shared profile seed rather than a per-process random.
   *
   * @param {number} timeUs         raw time in microseconds
   * @param {bigint|number} contextMixin  the per-context mixin (0 for a global
   *   reference; the native caller passes the real BrowsingContext mixin)
   * @returns {number} reduced time in microseconds
   */
  quantizeTimerUs(timeUs, contextMixin = 0n) {
    const res = this.profile.timerResolutionUs;
    const clamped = Math.floor(timeUs / res) * res;
    if (!this.profile.timerJitter) {
      return clamped;
    }
    const hex = this.timerMidpointSeedHex();
    const seedLo = u64FromHexLE(hex, 0);
    const seedHi = u64FromHexLE(hex, 8);
    const ctx = BigInt(contextMixin) & MASK64;
    const rng = new XorShift128Plus(
      (ctx ^ seedLo) & MASK64,
      (BigInt(clamped) ^ seedHi) & MASK64
    );
    const midpoint = Number(rng.next() % BigInt(res));
    return timeUs >= clamped + midpoint ? clamped + res : clamped;
  }

  /**
   * The flattened set of static values a site observes across the section-7
   * surfaces. Two VentoTimeLocale built from the same seed+profile return a
   * deep-equal object on any machine — the CI-checkable identity property
   * (test_vento_time_locale.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      timezone: p.timezone,
      locale: p.locale,
      mathFdlibm: p.mathFdlibm,
      timerResolutionUs: p.timerResolutionUs,
      timerJitter: p.timerJitter,
      timerMidpointSeedHex: p.timerJitter ? this.timerMidpointSeedHex() : null,
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-7 target. Enabling JSMathFdlibm closes Math for free (build
   * constant); enabling ReduceTimerPrecision floors the clock; enabling
   * JSDateTimeUTC / JSLocale installs the global spoofed zone/locale that the
   * per-profile native hook then overrides. Merge this into the profile-wide
   * overrides string (the master privacy.fingerprintingProtection toggle is owned
   * by the top-level applier, not this sub-module).
   *
   * @returns {string} e.g. "+JSDateTimeUTC,+JSLocale,+JSLocalePrompt,+JSMathFdlibm,+ReduceTimerPrecision"
   */
  overridesFragment() {
    return SECTION7_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the genuinely pref-controllable section-7 knobs. Names
   * verified against StaticPrefList.yaml. TZ and locale are intentionally NOT
   * here: RFP takes them from the native GetSpoofedJSTimeZone/GetSpoofedJSLocale
   * return values, not a pref, so the per-profile value is applied at the
   * injection point (residualVariance), and privacy.spoof_english (which forces
   * navigator.language to en-US) is owned by the top-level locale applier so it
   * can be kept consistent with the ICU locale rather than pinned to en-US here.
   *
   * @returns {Map<string, boolean|number>}
   */
  deterministicPrefs() {
    const p = this.profile;
    return new Map([
      // ReduceTimerPrecision(35): pin the floor resolution so every machine
      // clamps identically.
      [
        "privacy.resistFingerprinting.reduceTimerPrecision.microseconds",
        p.timerResolutionUs,
      ],
      // Turn jitter OFF for the default (floor-only, already deterministic)
      // path. Enabling it requires the deterministic-midpoint native hook, so it
      // stays false unless that hook is present.
      [
        "privacy.resistFingerprinting.reduceTimerPrecision.jitter",
        p.timerJitter,
      ],
    ]);
  }

  /**
   * A stable, human-auditable one-line descriptor of everything section 7 pins
   * under this profile. Deterministic, so the test can assert two machines share
   * it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    return [
      `tz=${v.timezone}`,
      `locale=${v.locale}`,
      `fdlibm=${+v.mathFdlibm}`,
      `res=${v.timerResolutionUs}us`,
      `jitter=${+v.timerJitter}`,
      `midpoint=${v.timerMidpointSeedHex ?? "-"}`,
    ].join("|");
  }

  /**
   * Per-surface map of how section 7 is closed: the RFPTarget that carries it, the
   * mechanism, and the exact core hook for auditing. Kept as data so ../README.md
   * and the test stay in sync with RFPTargets.inc / nsRFPService.cpp.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "Time zone (Date / Intl)",
        target: "JSDateTimeUTC",
        id: 22,
        mechanism: "rfp-target + native return-value swap",
        injectionPoint:
          "nsRFPService::GetSpoofedJSTimeZone() (nsRFPService.cpp) returns a " +
          "constant 'Atlantic/Reykjavik'; it is consumed at " +
          "js/xpconnect/src/nsXPConnect.cpp setTimeZoneOverride (also " +
          "WorkletGlobalScope / WorkerPrivate). Return profile.timezone instead " +
          "to key it per-profile; the value still flows through " +
          "JS::SetTimeZoneOverride / js::DateTimeInfo (js/src/vm/DateTime.cpp).",
      },
      {
        surface: "Locale (ICU default for Intl/Date)",
        target: "JSLocale / JSLocalePrompt",
        id: 13,
        mechanism: "rfp-target + native return-value swap",
        injectionPoint:
          "nsRFPService::GetSpoofedJSLocale() (nsRFPService.cpp) returns a " +
          "constant 'en-US'; consumed at nsXPConnect.cpp setLocaleOverride (also " +
          "workers/worklets/XSLT). Return profile.locale instead. Keep " +
          "privacy.spoof_english / navigator.language consistent with it.",
      },
      {
        surface: "Math ULP (sin/cos/... platform diff)",
        target: "JSMathFdlibm",
        id: 23,
        mechanism: "rfp-target",
        injectionPoint:
          "js/src/jsmath.cpp routes transcendental fns through bundled fdlibm " +
          "when the target is on; a build-constant, so ENABLING the target is " +
          "all that is needed (no native patch).",
      },
      {
        surface:
          "High-resolution timers (performance.now, Date.now, timeStamp)",
        target: "ReduceTimerPrecision",
        id: 35,
        mechanism: "rfp-target + pref (+ optional native midpoint hook)",
        injectionPoint:
          "nsRFPService::ReduceTimePrecisionImpl floors to " +
          "privacy.resistFingerprinting.reduceTimerPrecision.microseconds; the " +
          "jitter (privacy.resistFingerprinting.reduceTimerPrecision.jitter) uses " +
          "nsRFPService::RandomMidpoint with a per-process random " +
          "sSecretMidpointSeed. Default: jitter off => deterministic floor. " +
          "Optional: seed sSecretMidpointSeed from timerMidpointSeedHex() to make " +
          "jitter deterministic (see quantizeTimerUs for the reference math).",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-7 targets does NOT by itself remove —
   * the honest, as-data list of native remainders (mirrors the network/misc
   * modules). All three are small, well-scoped return-value/seed swaps; none is
   * an engine rewrite.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "timezone-per-profile",
        channel: "JSDateTimeUTC (positive per-profile zone)",
        whyNotTargetOnly:
          "Enabling JSDateTimeUTC forces the SAME global zone " +
          "('Atlantic/Reykjavik') on every machine — already deterministic, but " +
          "not the profile's own zone, and it must match the vento_proxy egress " +
          "geo or the mismatch is itself a tell. There is no pref for it; RFP " +
          "hardcodes the return value.",
        normalisedBy:
          "Return profile.timezone from nsRFPService::GetSpoofedJSTimeZone(). " +
          "Still 100% deterministic across machines with the same profile.",
        injectionPoint:
          "nsRFPService::GetSpoofedJSTimeZone() -> profile.timezone " +
          "(consumed by nsXPConnect.cpp setTimeZoneOverride).",
      },
      {
        id: "locale-per-profile",
        channel: "JSLocale (positive per-profile locale)",
        whyNotTargetOnly:
          "Enabling JSLocale forces 'en-US' everywhere — deterministic but not " +
          "the profile locale, and it must be consistent across the ICU default " +
          "locale, navigator.language(s) and Accept-Language or the split is a " +
          "tell.",
        normalisedBy:
          "Return profile.locale from nsRFPService::GetSpoofedJSLocale() and " +
          "align navigator.language / Accept-Language (privacy.spoof_english, " +
          "intl.accept_languages) with it.",
        injectionPoint:
          "nsRFPService::GetSpoofedJSLocale() -> profile.locale (consumed by " +
          "nsXPConnect.cpp setLocaleOverride).",
      },
      {
        id: "timer-deterministic-jitter",
        channel: "ReduceTimerPrecision (jitter-on path only)",
        whyNotTargetOnly:
          "The default (jitter off) is already deterministic. Turning jitter ON " +
          "(better against timing attacks) uses a per-process RANDOM " +
          "sSecretMidpointSeed, so two machines with the same profile would jitter " +
          "differently — breaking the identity guarantee.",
        normalisedBy:
          "Seed sSecretMidpointSeed from timerMidpointSeedHex() (a function of the " +
          "profile seed) so the midpoint stream is identical across machines. " +
          "quantizeTimerUs() is the byte-for-byte reference the native path must " +
          "match. Only needed if a profile opts into jitter.",
        injectionPoint:
          "nsRFPService::RandomMidpoint sSecretMidpointSeed init — replace the " +
          "GenerateRandomBytes seed with the 16 bytes of timerMidpointSeedHex().",
      },
    ];
  }
}
