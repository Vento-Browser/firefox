# Vento Fingerprint module (`browser/components/vento/fingerprint/`)

Isolated home for Vento's deterministic-identity fingerprinting feature (etap 2
of `../docs/FINGERPRINTING_RESEARCH.md`). The design constraint from Gleb: keep
**all** Vento fingerprint logic here so the whole thing can be lifted into a
standalone repo, leaving behind only a handful of small, well-documented
injection points in Firefox core.

## What lives here

- `VentoFingerprintProfile.sys.mjs` — engine-agnostic core. A profile plus a
  master `seed`; from that it derives every noise seed and static spoofed value
  **deterministically**, with zero dependency on Firefox internals. The same
  derivation can be re-implemented byte-for-byte in C++/Rust at the injection
  points below and produce identical output. This is what makes "identical
  fingerprint across two machines" a property we can unit-test in CI.
- `network/VentoNetworkFingerprint.sys.mjs` — engine-agnostic core for the
  **network/protocol** channel (section 9 of the research doc: TLS JA3/JA4,
  HTTP/2 & HTTP/3 Akamai fingerprint, header order, IP/ASN). Turns a network
  profile into a deterministic pref map (`deterministicPrefs()`) that makes every
  Vento machine emit an identical ClientHello + h2 fingerprint, plus an honest
  list of what prefs cannot fix (`residualVariance()`). The deep PoC write-up —
  what a unified build + `vento_proxy` already gives vs. what needs an NSS patch —
  is in `network/NETWORK_FINGERPRINT_POC.md`. Verdict: the wire fingerprint is
  already build-constant across machines; only one optional native patch remains
  (deterministic GREASE), the rest is prefs + proxy.
- `VentoAudio.sys.mjs` — engine-agnostic core for the **audio / AudioContext**
  channel (section 5 of the research doc: `AudioContext.sampleRate`,
  `destination.maxChannelCount`, base/output latency, and the classic
  OfflineAudioContext DSP hash). The static parameters already have spoofing code
  in Gecko gated behind their RFPTargets, so — like sections 6 and 8 — they need
  **no native patch of their own**: `overridesFragment()` emits the
  `+AudioSampleRate,+AudioContext` fragment and `deterministicPrefs()` hard-pins
  `media.cubeb.force_sample_rate`. The defaults mirror what enabling those targets
  produces (44100 Hz, 2 channels), with one honest exception pinned fleet-wide:
  latency, whose RFP constant is OS-dependent. The DSP hash is a special case —
  Gecko adds **no** RFP noise to WebAudio buffers, and the DynamicsCompressor +
  ffvpx FFT are pure software, so a same-build/same-SIMD fleet is already
  byte-identical; the only residual is cross-CPU SIMD divergence, closed
  optionally by `perturbSamples()`, the byte-for-byte seed-derived micro-noise
  reference a native buffer hook must reproduce. Both remainders (cross-OS latency,
  cross-CPU SIMD) are enumerated honestly by `residualVariance()`.
- `VentoInputDevices.sys.mjs` — engine-agnostic core for the **input devices /
  sensors / media devices** channel (section 6 of the research doc:
  maxTouchPoints/touch, `MediaDevices.enumerateDevices`, MediaCapabilities,
  Gamepad, DeviceSensors, pointer/keyboard/CSS-pointer capabilities,
  NetworkConnection, `StorageManager.estimate` quota, Battery). Like section 8,
  every one of these surfaces already has spoofing code in Gecko gated behind its
  RFPTarget, so section 6 needs **no native patch of its own**: it is closed by
  ENABLING the right targets. `overridesFragment()` emits the
  `+TouchEvents,+MaxTouchPoints,...` fragment to merge into
  `privacy.fingerprintingProtection.overrides`, and `deterministicPrefs()` pins
  the one genuine value pref (`dom.battery.enabled`, since Battery is not an
  RFPTarget). The defaults mirror exactly what enabling those targets produces —
  a mouse-only, no-touch, no-sensors, no-gamepad desktop with a single
  camera/mic/speaker, `"unknown"` connection and a 50 GiB quota. The only native
  remainders — needed solely if a profile wants a *positive* value (a non-zero
  touch count, a specific device-count shape, a custom storage limit) instead of
  the deny-by-default constant — are enumerated honestly by `residualVariance()`.
- `VentoMiscSurfaces.sys.mjs` — engine-agnostic core for the **misc web-API
  surfaces** channel (section 8 of the research doc: SpeechSynthesis voices,
  ScreenOrientation, `<video>` moz-frame counters / playback quality, WebVTT,
  FrameRate/vsync, IMEStyle, MediaError message, native colors). Unlike canvas/
  WebGL, every one of these already has spoofing code in Gecko gated behind its
  RFPTarget, so section 8 needs **no native patch of its own**: it is closed by
  ENABLING the right targets. `overridesFragment()` emits the
  `+ScreenOrientation,+SpeechSynthesis,...` fragment to merge into
  `privacy.fingerprintingProtection.overrides`, and `deterministicPrefs()` pins
  the two genuine value prefs (`layout.frame_rate`,
  `ui.use_standins_for_native_colors`). The only native remainder — needed solely
  if a profile wants a *positive* value (a non-empty unified voice list / a
  specific IME style) instead of the empty/hidden deny-by-default — is enumerated
  honestly by `residualVariance()`.
- `VentoTimeLocale.sys.mjs` — engine-agnostic core for the **time / timers / TZ /
  locale / Math** channel (section 7 of the research doc). Math (fdlibm) is a
  build-constant closed for free by enabling `JSMathFdlibm`; the timer reducer is
  pinned to a deterministic floor (`deterministicPrefs()` sets the resolution and
  turns the random-seeded jitter OFF), and TZ/locale default to exactly what RFP
  forces (Reykjavik / en-US) so an un-configured install is byte-identical to RFP.
  A real profile wants its own zone/locale (to match the `vento_proxy` egress geo)
  and, optionally, deterministic jitter-on: those three small native remainders —
  two return-value swaps in `nsRFPService` and one seed swap in `RandomMidpoint` —
  are enumerated honestly by `residualVariance()`, and `quantizeTimerUs()` is the
  byte-for-byte reference the native jitter path must match.
- `VentoBehavioralQuantizer.sys.mjs` — engine-agnostic core for the
  **behavioral** channel (section 10 of the research doc: mouse/keyboard/timing,
  level 1). Derives seed-based grid phases and quantizes event timestamps and
  pointer coordinates deterministically. Scope note: the behavioral channel can
  only be *blunted* (lower its resolution), not made byte-identical across two
  live humans without wrecking UX — so this is intentionally the cheap,
  high-impact half. Level 2 (synthetic trajectories / keystroke resampling) is
  out of scope by design.

## The single most important injection point

Firefox salts canvas/WebGL/audio randomization with a **random per-session
UUID**:

```
nsRFPService::GetBrowsingSessionKey()
  -> mBrowsingSessionKeys.InsertOrUpdate(oaSuffix, nsID::GenerateUUID())
  toolkit/components/resistfingerprinting/nsRFPService.cpp
```

To get identical output across machines this random key must be replaced with
`VentoFingerprintProfile.surfaceSeedHex(surface, origin)` — a deterministic
function of `(profileSeed, surface, origin)`. That is the one core patch; the
rest of the surfaces (navigator/screen/timezone/fonts...) are "pin the RFP
target to the profile value" edits enumerated in the research doc.

## Planned injection points (kept minimal & documented for extraction)

| Surface | Core hook | Replace with |
|---|---|---|
| canvas/webgl/audio noise | `nsRFPService::GetBrowsingSessionKey` | `surfaceSeedHex(...)` |
| navigator/screen/timezone/fonts | `nsRFPService::GetSpoofed*` targets | `getSpoofedValues()` field |
| time zone / locale (§7) | `nsRFPService::GetSpoofedJSTimeZone()` / `GetSpoofedJSLocale()` (consumed at `js/xpconnect/src/nsXPConnect.cpp` `setTimeZoneOverride` / `setLocaleOverride`) | return `VentoTimeLocale.getSpoofedValues().timezone` / `.locale` per profile instead of the `Atlantic/Reykjavik` / `en-US` constants |
| Math ULP (§7) | RFPTarget `JSMathFdlibm`(23) | ENABLE via `overridesFragment()`; build-constant, no native patch |
| timer precision (§7) | `nsRFPService::ReduceTimePrecisionImpl` resolution + `nsRFPService::RandomMidpoint` seed | default: pin resolution + jitter off via `deterministicPrefs()` (deterministic floor). Optional jitter-on: seed `sSecretMidpointSeed` from `timerMidpointSeedHex()`; `quantizeTimerUs()` is the reference math |
| audio parameters (§5) | existing RFPTargets `AudioSampleRate`(39), `AudioContext`(49) + pref `media.cubeb.force_sample_rate` | ENABLE the targets via `overridesFragment()` + `deterministicPrefs()`; no native patch needed (build-constant 44100/2ch). Optional native pin of `AudioContext::OutputLatency()` (`dom/media/webaudio/AudioContext.cpp`) to `getSpoofedValues().outputLatency` for cross-OS identity — see `residualVariance()`. |
| audio DSP hash (§5) | `dom/media/webaudio/` buffer readback (ffvpx `av_tx` in `FFTBlock.h` + `DynamicsCompressor`) | build-constant for a same-build/same-SIMD fleet (Gecko adds no RFP noise here). Optional: force the scalar ffvpx kernel, or add `VentoAudio.perturbSamples()` output to the rendered buffer to mask cross-CPU SIMD divergence — see `residualVariance()`. |
| misc web-API surfaces (§8) | existing RFPTargets `ScreenOrientation`(4), `SpeechSynthesis`(5), `VideoElementMozFrames`(32-34), `FrameRate`(46), `UseStandinsForNativeColors`(48), `MediaError`(50), `WebVTT`(63), `IMEStyle`(81) | ENABLE the targets via `overridesFragment()` + `deterministicPrefs()`; no native patch needed (deny-by-default constant). Optional native voice-registry / IME hook only for a *positive* unified value — see `residualVariance()`. |
| input/sensors/media devices (§6) | existing RFPTargets `TouchEvents`(1), `PointerEvents`(2), `KeyboardEvents`(3), `StreamVideoFacingMode`(21), `Gamepad`(24), `MediaDevices`(37), `MediaCapabilities`(38), `NetworkConnection`(40), `DeviceSensors`(45), `CSSPointerCapabilities`(58), `DiskStorageLimit`(70), `MaxTouchPoints`(72), `MaxTouchPointsCollapse`(73) + pref `dom.battery.enabled` | ENABLE the targets via `overridesFragment()` + `deterministicPrefs()`; no native patch needed (deny-by-default constant). Optional native hook only for a *positive* touch count / device shape / storage limit — see `residualVariance()`. |
| event timestamps (behavioral) | `nsRFPService::ReduceTimePrecisionImpl` / `WidgetEvent` timestamp path (RFPTarget `WidgetEvents`) | `quantizeTimestampMs(...)` — same floor-to-grid with the seed-derived phase instead of RFP's random per-context midpoint |
| pointer coordinates (behavioral) | `MouseEvent` screen-point path (RFPTarget `MouseEventScreenPoint`) | `quantizeCoord(...)` grid coarsening |
| TLS GREASE bytes (raw JA3 only) | `tls13_ClientSetupGrease` (`security/nss/lib/ssl/tls13con.c`) | deterministic GREASE seed from the profile (only needed for byte-identical raw JA3; JA4 already ignores GREASE) |
| TLS/h2 pref-pinnable variance | `Services.prefs` at panel/BrowserGlue | `VentoNetworkFingerprint.deterministicPrefs()` |
| IP/ASN + TCP/IP stack | none in-browser | `vento_proxy` egress (TZ/locale must match proxy geo) |
| profile storage/sync | Vento panel + backend component | `export()` / `import()` |

The two behavioral hooks are the level-1 injection points for section 10. The
JS module here is the byte-for-byte reference: the C++ side must floor onto the
same grid using the same seed-derived phase (`unitFromSeed(seed + " behavioral-*-phase")`)
so a build with the patch and this module agree. Keeping the reference in JS is
what lets `test_vento_fingerprint_behavioral.js` assert the mitigation
(determinism + sub-grid collapse) in CI without driving real input hardware.

## How determinism is tested

- **Unit / CI (deterministic):**
  `browser/components/tests/unit/test_vento_fingerprint_determinism.js` builds
  two independent profiles from the same data ("two machines") and asserts
  byte-identical seeds, noise streams and spoofed values. Each channel has its
  own sibling test (`test_vento_audio.js`, `test_vento_input_devices.js`,
  `test_vento_misc_surfaces.js`, `test_vento_network_fingerprint.js`,
  `test_vento_fingerprint_behavioral.js`, `test_vento_time_locale.js`) asserting
  the same two-machine identity plus that channel's mitigation.
- **E2E (hardware-dependent):** `vento-test-env/fingerprint/` — a CreepJS-style
  collector page plus a JSON snapshot comparator, run on two physically
  different stands (different GPU/OS) to catch hardware leaks the unit test
  cannot see (real canvas/WebGL/audio/TLS).
