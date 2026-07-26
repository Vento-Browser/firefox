/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Input Devices / Sensors / Media Devices — the isolated, engine-agnostic
 * core of section 6 ("Устройства ввода/датчики/медиа-девайсы") of
 * FINGERPRINTING_RESEARCH.md.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox core (see ../README.md). Nothing here
 * depends on Firefox internals — it is pure data: a (partial) profile in, a
 * deterministic set of spoofed values + a pref map out.
 *
 * The section-6 surfaces, with their RFPTarget id (RFPTargets.inc):
 *
 *   TouchEvents (1)               ontouchstart / Touch* interface exposure
 *   PointerEvents (2)             pointer event capabilities
 *   KeyboardEvents (3)            keyboard layout / KeyboardEvent tells
 *   StreamVideoFacingMode (21)    MediaTrackSettings.facingMode
 *   Gamepad (24)                  navigator.getGamepads()
 *   MediaDevices (37)             MediaDevices.enumerateDevices() list
 *   MediaCapabilities (38)        MediaCapabilities.decodingInfo() power/smooth
 *   NetworkConnection (40)        navigator.connection type/downlink
 *   DeviceSensors (45)            DeviceMotion / DeviceOrientation
 *   CSSPointerCapabilities (58)   (any-)pointer / (any-)hover media features
 *   DiskStorageLimit (70)         StorageManager.estimate() quota
 *   MaxTouchPoints (72)           navigator.maxTouchPoints
 *   MaxTouchPointsCollapse (73)   collapse a real touch count to a coarse value
 *
 * KEY FINDING (verified against the tree, RFPTargets.inc + nsRFPService +
 * Navigator.cpp + MediaDevices.cpp + Connection.h + ActorsParent.cpp +
 * nsMediaFeatures.cpp): every one of these already has spoofing code in Gecko
 * gated behind its RFPTarget. When the target is ENABLED the value is forced to a
 * build-constant:
 *   - maxTouchPoints => SPOOFED_MAX_TOUCH_POINTS (0 on desktop; the fleet default
 *     here is a mouse-only 0 so touch is denied everywhere);
 *   - enumerateDevices() => exactly one device of each kind (mic/cam/speaker),
 *     backfilled with fakes — i.e. a fixed 1/1/1 shape, no real groupIds;
 *   - navigator.connection.type => "unknown";
 *   - StorageManager.estimate().quota => GetSpoofedStorageLimit() = 50 GiB;
 *   - (any-)pointer/(any-)hover => the desktop default (fine + hover);
 *   - Gamepad / DeviceSensors => the surface is blocked (no gamepads / no events).
 * Battery is NOT an RFPTarget: Firefox already hides the Battery API from content
 * (dom.battery.enabled defaults false); the profile just re-asserts that.
 *
 * A build constant is by definition identical on every machine, so — like section
 * 8 — section 6 needs NO native patch of its own: it is fully closed by ENABLING
 * the right RFPTargets via `privacy.fingerprintingProtection.overrides` (parsed by
 * nsRFPService::CreateOverridesFromText) plus the one genuine value pref
 * (dom.battery.enabled). `overridesFragment()` emits the `+Target` list and
 * `deterministicPrefs()` adds the pref(s).
 *
 * The ONLY thing that would need a native hook is if a profile wants a *positive*
 * value that differs from the deny-by-default constant (a non-zero touch count, a
 * specific device-count shape, a custom storage limit); those native remainders
 * are enumerated honestly in `residualVariance()`.
 */

/**
 * The section-6 RFPTargets, by the exact name TextToRFPTarget expects. Enabling
 * every one of these is what forces each surface to its build-constant. Kept as
 * data so `overridesFragment()`, the descriptor and the test stay in sync, and so
 * the list can be audited against RFPTargets.inc in review.
 */
export const SECTION6_TARGETS = Object.freeze([
  "TouchEvents", // 1
  "PointerEvents", // 2
  "KeyboardEvents", // 3
  "StreamVideoFacingMode", // 21
  "Gamepad", // 24
  "MediaDevices", // 37
  "MediaCapabilities", // 38
  "NetworkConnection", // 40
  "DeviceSensors", // 45
  "CSSPointerCapabilities", // 58
  "DiskStorageLimit", // 70
  "MaxTouchPoints", // 72
  "MaxTouchPointsCollapse", // 73
]);

/** GetSpoofedStorageLimit() in nsRFPService.cpp: 50 GiB. */
const SPOOFED_STORAGE_LIMIT_BYTES = 50 * 1024 * 1024 * 1024;

/**
 * The fleet-wide default for the section-6 observables. Every value MUST be
 * identical on every Vento install for the cross-machine identity guarantee to
 * hold — that is the whole point — so these are frozen constants, NOT derived
 * from the profile seed (a seed-varied value here would make two machines with
 * the same profile differ). The defaults mirror exactly what enabling the
 * corresponding RFPTarget produces in Gecko, so the module is a faithful
 * reference for what a site actually observes: a desktop, mouse-only, no-touch,
 * no-sensors, no-gamepad machine with a single camera/mic/speaker.
 */
export const DEFAULT_INPUT_PROFILE = Object.freeze({
  // MaxTouchPoints(72) / MaxTouchPointsCollapse(73) / TouchEvents(1): a mouse-only
  // desktop. 0 is what SPOOFED_MAX_TOUCH_POINTS is on desktop; touch interfaces
  // are denied so ontouchstart is absent.
  maxTouchPoints: 0,
  touchEventsEnabled: false,

  // MediaDevices(37): enumerateDevices() exposes exactly one device of each kind.
  // Gecko backfills fakes so the shape is always mic=1, cam=1, speaker=1 with no
  // real groupIds/labels. Pin that shape.
  mediaDeviceCounts: Object.freeze({
    audioinput: 1,
    videoinput: 1,
    audiooutput: 1,
  }),

  // StreamVideoFacingMode(21): MediaTrackSettings.facingMode hidden (empty).
  streamVideoFacingMode: "",

  // MediaCapabilities(38): decodingInfo() unified — not power-efficient / not
  // smooth, so codec/GPU tells don't leak through capability probes.
  mediaCapabilitiesPowerEfficient: false,
  mediaCapabilitiesSmooth: false,

  // Gamepad(24): getGamepads() blocked -> no gamepads ever visible.
  gamepadsExposed: false,

  // DeviceSensors(45): DeviceMotion / DeviceOrientation blocked.
  deviceSensorsExposed: false,

  // PointerEvents(2) / KeyboardEvents(3) / CSSPointerCapabilities(58): desktop
  // mouse. (any-)pointer resolves to "fine" and (any-)hover to "hover", matching
  // the desktop deny-by-default in nsMediaFeatures.cpp.
  primaryPointer: "fine",
  primaryHover: true,
  anyPointer: "fine",
  anyHover: true,

  // NetworkConnection(40): navigator.connection.type -> "unknown" (Connection.h).
  networkConnectionType: "unknown",

  // DiskStorageLimit(70): StorageManager.estimate().quota constant (50 GiB).
  storageQuotaBytes: SPOOFED_STORAGE_LIMIT_BYTES,

  // Battery: Firefox already hides the Battery API from content; keep it hidden.
  batteryExposed: false,
});

const VALID_POINTER = new Set(["none", "coarse", "fine"]);

/**
 * The section-6 surfaces bundled as a deterministic profile. Constructed from a
 * (partial) profile merged over DEFAULT_INPUT_PROFILE, so callers only override
 * what the Vento panel exposes.
 */
export class VentoInputDevices {
  /**
   * @param {object} [profile] Partial overrides of DEFAULT_INPUT_PROFILE.
   */
  constructor(profile = {}) {
    this.profile = Object.freeze({
      ...DEFAULT_INPUT_PROFILE,
      ...profile,
      mediaDeviceCounts: Object.freeze({
        ...DEFAULT_INPUT_PROFILE.mediaDeviceCounts,
        ...(profile.mediaDeviceCounts || {}),
      }),
    });
    const p = this.profile;
    if (!Number.isInteger(p.maxTouchPoints) || p.maxTouchPoints < 0) {
      throw new Error("maxTouchPoints must be a non-negative integer");
    }
    for (const kind of ["audioinput", "videoinput", "audiooutput"]) {
      const n = p.mediaDeviceCounts[kind];
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `mediaDeviceCounts.${kind} must be a non-negative integer`
        );
      }
    }
    if (!Number.isInteger(p.storageQuotaBytes) || p.storageQuotaBytes <= 0) {
      throw new Error("storageQuotaBytes must be a positive integer");
    }
    if (
      !VALID_POINTER.has(p.primaryPointer) ||
      !VALID_POINTER.has(p.anyPointer)
    ) {
      throw new Error("pointer capability must be one of none|coarse|fine");
    }
  }

  /**
   * Build from a VentoFingerprintProfile (or anything with `.fields`). Section 6
   * values are intentionally fleet-wide constants, not seed-derived, so this only
   * threads through any explicit section-6 fields the profile carries; it does
   * NOT consult the seed. Keeping the constructor symmetric with the other
   * fingerprint modules.
   *
   * @param {object} profile A VentoFingerprintProfile (or anything with `.fields`).
   * @param {object} [overrides] Explicit section-6 overrides, applied last.
   * @returns {VentoInputDevices}
   */
  static fromProfile(profile, overrides = {}) {
    const fields = (profile && profile.fields) || {};
    const passthrough = {};
    for (const key of Object.keys(DEFAULT_INPUT_PROFILE)) {
      if (key in fields) {
        passthrough[key] = fields[key];
      }
    }
    return new VentoInputDevices({ ...passthrough, ...overrides });
  }

  /**
   * The flattened set of static values a site observes across all section-6
   * surfaces. Two VentoInputDevices built from the same profile return a
   * deep-equal object on any machine — that is the CI-checkable identity property
   * (test_vento_input_devices.js).
   */
  getSpoofedValues() {
    const p = this.profile;
    return {
      maxTouchPoints: p.maxTouchPoints,
      touchEventsEnabled: p.touchEventsEnabled,
      mediaDeviceCounts: { ...p.mediaDeviceCounts },
      streamVideoFacingMode: p.streamVideoFacingMode,
      mediaCapabilities: {
        powerEfficient: p.mediaCapabilitiesPowerEfficient,
        smooth: p.mediaCapabilitiesSmooth,
      },
      gamepadsExposed: p.gamepadsExposed,
      deviceSensorsExposed: p.deviceSensorsExposed,
      pointer: {
        primaryPointer: p.primaryPointer,
        primaryHover: p.primaryHover,
        anyPointer: p.anyPointer,
        anyHover: p.anyHover,
      },
      networkConnectionType: p.networkConnectionType,
      storageQuotaBytes: p.storageQuotaBytes,
      batteryExposed: p.batteryExposed,
    };
  }

  /**
   * The `privacy.fingerprintingProtection.overrides` fragment that ENABLES every
   * section-6 target. This is the mechanism that makes the surfaces deterministic
   * without any native patch: nsRFPService::CreateOverridesFromText parses this
   * comma-separated `+Target` list and each enabled target forces its surface to
   * the build-constant reflected in DEFAULT_INPUT_PROFILE. Merge this fragment into
   * the profile-wide overrides string (the master privacy.fingerprintingProtection
   * toggle is owned by the top-level profile applier, not this sub-module).
   *
   * @returns {string} e.g. "+TouchEvents,+PointerEvents,..."
   */
  overridesFragment() {
    return SECTION6_TARGETS.map(t => `+${t}`).join(",");
  }

  /**
   * The pref map for the section-6 knobs that are genuinely pref-controllable
   * (i.e. carry a real value, not just a target toggle). Pref names verified
   * against StaticPrefList.yaml. The target-enable list is intentionally NOT
   * folded in here as a single pref write, because it must be MERGED with the
   * rest of the profile's overrides fragment rather than overwrite it — use
   * `overridesFragment()` for that.
   *
   * Battery is not an RFPTarget, so hiding it is a genuine pref
   * (dom.battery.enabled). When a profile keeps the Battery API hidden (the
   * default) we pin the pref off; when a profile deliberately exposes it, we
   * leave the pref alone so the browser default applies.
   *
   * @returns {Map<string, boolean|number>}
   */
  deterministicPrefs() {
    const p = this.profile;
    const prefs = new Map();
    if (!p.batteryExposed) {
      prefs.set("dom.battery.enabled", false);
    }
    return prefs;
  }

  /**
   * A stable, human-auditable descriptor of everything section 6 pins under this
   * profile. Deterministic function of the profile, so the test can assert two
   * machines share it and a review can spot a drift in one line.
   *
   * @returns {string}
   */
  surfaceDescriptor() {
    const v = this.getSpoofedValues();
    const dc = v.mediaDeviceCounts;
    return [
      `touch=${v.maxTouchPoints}/${+v.touchEventsEnabled}`,
      `devices=${dc.audioinput}/${dc.videoinput}/${dc.audiooutput}`,
      `facing="${v.streamVideoFacingMode}"`,
      `mediacaps=${+v.mediaCapabilities.powerEfficient}/${+v.mediaCapabilities.smooth}`,
      `gamepad=${+v.gamepadsExposed}`,
      `sensors=${+v.deviceSensorsExposed}`,
      `pointer=${v.pointer.primaryPointer}/${+v.pointer.primaryHover}`,
      `net=${v.networkConnectionType}`,
      `quota=${v.storageQuotaBytes}`,
      `battery=${+v.batteryExposed}`,
    ].join("|");
  }

  /**
   * Per-surface map of how section 6 is closed: the RFPTarget that carries it, the
   * mechanism (mostly "rfp-target" — enable via the overrides fragment), and the
   * exact core hook for auditing. Kept as data so ../README.md and the test stay
   * in sync with RFPTargets.inc.
   *
   * @returns {Array<{surface:string, target:string, id:number,
   *   mechanism:string, injectionPoint:string}>}
   */
  injectionPoints() {
    return [
      {
        surface: "maxTouchPoints / touch",
        target: "MaxTouchPoints / MaxTouchPointsCollapse / TouchEvents",
        id: 72,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/base/Navigator.cpp Navigator::MaxTouchPoints — returns " +
          "SPOOFED_MAX_TOUCH_POINTS under RFPTarget::MaxTouchPoints (0 on desktop).",
      },
      {
        surface: "MediaDevices.enumerateDevices",
        target: "MediaDevices / StreamVideoFacingMode",
        id: 37,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/media/MediaDevices.cpp — under RFPTarget::MediaDevices exactly one " +
          "device of each kind is exposed (fakes backfilled), facingMode hidden.",
      },
      {
        surface: "MediaCapabilities.decodingInfo",
        target: "MediaCapabilities",
        id: 38,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/media/MediaCapabilities — power-efficient/smooth unified under " +
          "RFPTarget::MediaCapabilities.",
      },
      {
        surface: "Gamepad",
        target: "Gamepad",
        id: 24,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/gamepad/GamepadManager.cpp — getGamepads() blocked under " +
          "RFPTarget::Gamepad.",
      },
      {
        surface: "DeviceSensors (motion/orientation)",
        target: "DeviceSensors",
        id: 45,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/system/nsDeviceSensors.cpp — sensor events gated on " +
          "RFPTarget::DeviceSensors.",
      },
      {
        surface: "Pointer / hover capabilities",
        target: "PointerEvents / KeyboardEvents / CSSPointerCapabilities",
        id: 58,
        mechanism: "rfp-target",
        injectionPoint:
          "layout/style/nsMediaFeatures.cpp GetPointerCapabilities — desktop " +
          "default (fine+hover) under RFPTarget::CSSPointerCapabilities.",
      },
      {
        surface: "Network Information",
        target: "NetworkConnection",
        id: 40,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/network/Connection.h Connection::Type — returns 'unknown' under " +
          "RFPTarget::NetworkConnection.",
      },
      {
        surface: "Storage quota (StorageManager.estimate)",
        target: "DiskStorageLimit",
        id: 70,
        mechanism: "rfp-target",
        injectionPoint:
          "dom/quota/ActorsParent.cpp GetTemporaryStorageLimit -> " +
          "nsRFPService::GetSpoofedStorageLimit() (50 GiB) under " +
          "RFPTarget::DiskStorageLimit.",
      },
      {
        surface: "Battery",
        target: "(none — pref)",
        id: 0,
        mechanism: "pref",
        injectionPoint:
          "dom/battery — the Battery API is hidden from content via " +
          "dom.battery.enabled (deterministicPrefs), not an RFPTarget.",
      },
    ];
  }

  /**
   * The variance that ENABLING the section-6 targets does NOT by itself remove.
   * Like section 8, enabling the targets already yields a build-constant
   * (deny-by-default) for every surface, so this list is only the OPTIONAL native
   * work needed if a profile wants a richer *positive* value (a non-zero touch
   * count, a specific device-count shape, a custom storage limit) instead of the
   * mouse-only / one-of-each / 50-GiB default. Kept honest and as data, mirroring
   * the network and misc-surfaces modules.
   *
   * @returns {Array<{id:string, channel:string, whyNotTargetOnly:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "positive-touch-count",
        channel: "MaxTouchPoints (positive value only)",
        whyNotTargetOnly:
          "Enabling RFPTarget::MaxTouchPoints forces SPOOFED_MAX_TOUCH_POINTS " +
          "(0 on desktop) on every machine (already deterministic). A profile that " +
          "wants a NON-ZERO touch count identical across machines cannot get it " +
          "from a pref — the constant is compiled in.",
        normalisedBy:
          "Default (0, mouse-only) needs nothing. For a positive count, return " +
          "profile.maxTouchPoints from Navigator::MaxTouchPoints when RFP is active.",
        injectionPoint:
          "dom/base/Navigator.cpp Navigator::MaxTouchPoints — return " +
          "VentoInputDevices.getSpoofedValues().maxTouchPoints instead of " +
          "SPOOFED_MAX_TOUCH_POINTS.",
      },
      {
        id: "positive-device-shape",
        channel: "MediaDevices (positive device-count shape only)",
        whyNotTargetOnly:
          "Enabling RFPTarget::MediaDevices exposes exactly one device of each " +
          "kind (deterministic). A different fixed shape (e.g. two cameras) would " +
          "need a native hook, not a pref.",
        normalisedBy:
          "Default (1/1/1) needs nothing; a custom shape is an optional native hook.",
        injectionPoint:
          "dom/media/MediaDevices.cpp — synthesize profile.mediaDeviceCounts fake " +
          "devices instead of the fixed one-per-kind backfill.",
      },
      {
        id: "custom-storage-limit",
        channel: "DiskStorageLimit (custom value only)",
        whyNotTargetOnly:
          "Enabling RFPTarget::DiskStorageLimit returns GetSpoofedStorageLimit() " +
          "(50 GiB) on every machine (already deterministic). A different fixed " +
          "quota can be pinned via dom.quotaManager.temporaryStorage.fixedLimit " +
          "(in KiB), but that path is not RFP-gated.",
        normalisedBy:
          "Default (50 GiB) needs nothing; a custom quota is the optional " +
          "dom.quotaManager.temporaryStorage.fixedLimit pref.",
        injectionPoint:
          "toolkit/components/resistfingerprinting/nsRFPService.cpp " +
          "GetSpoofedStorageLimit — or the fixedLimit pref for a custom value.",
      },
    ];
  }
}
