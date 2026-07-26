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
- `VentoNavigator.sys.mjs` — engine-agnostic core for the **navigator + HTTP
  client-hints** channel (section 1 of the research doc: User-Agent JS+HTTP,
  platform/oscpu/appVersion/buildID, hardwareConcurrency, languages/Accept-Language,
  plugins/pdfViewer, and the derived Sec-CH-UA / `userAgentData` surface). Section 1
  is the block where Vento's goal DIVERGES from stock RFP: RFP keeps the *real* OS
  (`nsRFPService::GetSpoofedUserAgent` builds from the per-build `SPOOFED_UA_OS`
  macro, `Navigator::GetPlatform` returns Win32/MacIntel/Linux per build), so two
  RFP users on Windows vs. macOS report DIFFERENT navigator.* — the opposite of what
  Vento needs. So — unlike the deny-by-default sections — the primary mechanism is
  NOT `overridesFragment()` (enabling a target re-pins each machine to its own per-OS
  constant) but `deterministicPrefs()`, which emits the `general.*.override` prefs
  (`useragent`/`appversion`/`platform`/`oscpu`/`buildID`) that Gecko already honours
  in `Navigator.cpp` / `nsHttpHandler` and that take ONE fleet-wide value regardless
  of host OS, with no native patch, plus `intl.accept_languages`. `OS_DESCRIPTORS`
  bundles the mutually-consistent tokens per OS and `consistency()` is the
  machine-checkable assertion that UA <-> platform <-> oscpu <-> UA-CH cannot
  contradict (a mismatch is itself a fingerprint). The genuine native remainders —
  forcing hardwareConcurrency UP past the real core count (the pref only clamps
  down), emitting a positive Sec-CH-UA/`userAgentData` surface (Firefox implements
  no UA client hints), and — if the RFP master toggle is on — making `GetSpoofed*`
  return the profile value cross-OS — are enumerated honestly by `residualVariance()`.
- `VentoGraphics.sys.mjs` — engine-agnostic core for the **graphics** channel
  (section 3 of the research doc: Canvas 2D / WebGL / WebGPU / WebCodecs — the
  "fattest" entropy channel). Splits into four sub-surfaces. The **parameter**
  surfaces (WebGL `getParameter` limits + UNMASKED vendor/renderer, WebGPU limits/
  `isFallbackAdapter`/subgroup sizes, WebCodecs configs) close like sections 6/8:
  `overridesFragment()` enables their targets and `deterministicPrefs()` pins
  `webgl.override-unmasked-vendor`/`-renderer` — no native patch of their own. The
  **pixel-readback** surface (canvas 2D + WebGL `readPixels`) is the crux and the
  reason this PoC exists: Firefox already noises readback, but keyed off a RANDOM
  session UUID, so `canvasSeedHex()`/`webglSeedHex()` replace it with a
  deterministic seed (the ONE core patch, at `nsRFPService::GetBrowsingSessionKey`,
  below). That is necessary but NOT sufficient, because the noise rides on a
  hardware-dependent base render — so `strategyVerdict()` records the decision:
  **route (b), a unified software render for readback** (`softwareRender` ->
  `gfx.canvas.accelerated=false`, `webgl.forbid-hardware=true`,
  `gfx.webrender.software=true`) makes the base bytes identical fleet-wide, and the
  deterministic seed-noise (`readbackNoise()`/`perturbPixels()`, the byte-for-byte
  reference a native hook must reproduce) then rides identically on top. Route (a)
  (noise only) is kept as the cheaper, non-100% option. Hardware rendering stays on
  for on-screen drawing; the honest costs (software-render perf/parity, canvas-text
  glyph metrics shared with section 4, cross-CPU software SIMD) are enumerated in
  `residualVariance()`. The deep write-up is `GRAPHICS_FINGERPRINT_POC.md`.
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
- `VentoScreenWindow.sys.mjs` — engine-agnostic core for the **screen / window /
  DPI / CSS-media** channel (section 2 of the research doc: `screen.*`,
  `window.outer/inner/screenXY`, `devicePixelRatio`, and the dozens of CSS
  `@media` features). Splits into two halves. The **CSS-media** half closes like
  section 8: `overridesFragment()` enables its targets and each collapses to a
  build-constant — color-gamut => srgb, resolution => the rounded DPR, color =>
  8bpp, dynamic-range => standard, prefers-* => the light/no-preference pose — no
  native patch of their own. The **geometry** half (ScreenRect/ScreenAvailRect/
  Window*Size/DevicePixelRatio) is the honest exception: enabling the targets makes
  Gecko report the *letterboxed inner-window* rect and the *rounded* window size
  (a function of the actual window), not a fixed profile screen, so pinning to a
  *positive* profile value identical across two differently-sized real monitors is
  the one genuine native remainder, enumerated by `residualVariance()`. Ownership
  note: the CSS `pointer`/`hover` features (RFPTarget `CSSPointerCapabilities`(58))
  are owned by the section-6 module (VentoInputDevices) since they are an
  input-device property; this module only mirrors their fleet-wide values in
  `getSpoofedValues().cssMedia`, it does not enable the target.
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
- `VentoFonts.sys.mjs` — engine-agnostic core for the **fonts** channel
  (section 4 of the research doc: the available-font list + glyph render metrics).
  The list half is the tractable, high-signal one: `overridesFragment()` emits the
  `+FontVisibilityBaseSystem,+FontVisibilityLangPack,+FontVisibilityRestrictGenerics,+UseHardcodedFontSubstitutes,+DOMStyleOsxFontSmoothing`
  fragment and `deterministicPrefs()` pins `layout.css.font-visibility=1`, which
  together clamp the enumerable families to the base tier and hide every
  user-installed font — killing the biggest entropy source on each machine.
  `getSpoofedValues().fonts` is the normalised (de-duplicated, sorted) fleet-wide
  whitelist a site must observe. Unlike section 8 this is NOT fully closed by
  enabling targets: the base-system set is platform-hard-coded (Win/mac/Linux
  `StandardFonts-*.inc`), so a *cross-OS-identical* list needs one native
  remainder — classify visibility against the profile whitelist in
  `gfxPlatformFontList::GetVisibilityForFamily` — and glyph metrics (advances,
  kerning, hinting) are hardware-bound and stitch into the canvas-text channel
  (section 3). Both, plus an optional positive `-moz-osx-font-smoothing` pose, are
  enumerated honestly by `residualVariance()`.
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
| canvas/webgl/audio noise KEY (§3) | `nsRFPService::GetBrowsingSessionKey` | `VentoGraphics.canvasSeedHex(origin)` / `webglSeedHex(origin)` (deterministic seed replaces the random session UUID) — the one core patch |
| graphics: readback BASE render (§3) | none pref-closeable to 100% | route (b): `VentoGraphics.deterministicPrefs()` forces software canvas/WebGL/WebRender (`gfx.canvas.accelerated=false`, `webgl.forbid-hardware=true`, `gfx.webrender.software=true`) so the pre-noise bytes are fleet-identical; cross-OS identity needs one shared software rasterizer build — see `residualVariance()` |
| WebGL UNMASKED vendor/renderer (§3) | existing RFPTargets `WebGLRenderInfo`(60), `WebGLVendorConstant`(78), `WebGLRendererConstant`(80) + prefs `webgl.override-unmasked-vendor`/`-renderer` | ENABLE the targets via `overridesFragment()` + pin the strings via `deterministicPrefs()`; no native patch |
| WebGL limits / WebGPU / WebCodecs (§3) | existing RFPTargets `WebGLRenderCapability`(59), `WebGPULimits`(64), `WebGPUIsFallbackAdapter`(65), `WebGPUSubgroupSizes`(66), `WebCodecs`(71) | ENABLE the targets via `overridesFragment()`; deny/sanitize-by-default constant, no native patch. `getSpoofedValues()` is the fleet-wide reported shape |
| screen/window/DPI CSS-media (§2) | existing RFPTargets `ScreenPixelDepth`(29), `ScreenRect`(30), `ScreenAvailRect`(31), `WindowOuterSize`(26), `WindowScreenXY`(27), `WindowInnerScreenXY`(28), `RoundWindowSize`(47), `WindowDevicePixelRatio`(41), `CSSDeviceSize`(52), `CSSColorInfo`(53), `CSSResolution`(54), `CSSVideoDynamicRange`(57), `CSSPrefersColorScheme`(6), `CSSPrefersReducedMotion`(7), `CSSPrefersContrast`(8), `CSSPrefersReducedTransparency`(55), `CSSInvertedColors`(56), `SiteSpecificZoom`(61) + pref `browser.zoom.siteSpecific` | ENABLE the targets via `VentoScreenWindow.overridesFragment()` + pin `browser.zoom.siteSpecific=false` via `deterministicPrefs()`. CSS-media half is build-constant, no native patch; the geometry half reports the letterboxed inner-window rect — a *positive* fixed profile screen/DPR/window is the native remainder in `residualVariance()` (`nsScreen::GetRect`/`GetAvailRect`, `nsRFPService::GetDevicePixelRatioAtZoom`, `nsGlobalWindowOuter` geometry) |
| navigator UA/platform/oscpu/appVersion/buildID (§1) | `general.useragent.override` / `.appversion.override` / `.platform.override` / `.oscpu.override` / `.buildID.override` (honoured in `Navigator.cpp` + `nsHttpHandler::UserAgent`) — RFPTargets `NavigatorUserAgent`(19), `HttpUserAgent`(25), `NavigatorAppVersion`(14), `NavigatorPlatform`(18), `NavigatorOscpu`(17), `NavigatorBuildID`(15) | pin the fleet-wide value via `VentoNavigator.deterministicPrefs()` (one value across all OS — the cross-OS identity stock RFP can't give). Optional native remainder (RFP master toggle on): make `nsRFPService::GetSpoofedUserAgent` / `Navigator::GetPlatform`/`GetOscpu`/`GetAppVersion` return `getSpoofedValues()` instead of the per-OS `SPOOFED_*` macro — see `residualVariance()` |
| navigator.hardwareConcurrency (§1) | `dom.maxHardwareConcurrency` clamp in `RuntimeService::ClampedHardwareConcurrency` + RFPTargets `NavigatorHWConcurrency`(16), `NavigatorHWConcurrencyTiered`(74) | pin via `deterministicPrefs()` (clamps DOWN only). A value ABOVE the real core count is the native remainder (`residualVariance()`) |
| navigator languages / Accept-Language (§1) | `intl.accept_languages` (drives `LocaleService::GetAcceptLanguages` + `navigator.languages`) + RFPTarget `JSLocale`(13) | pin via `deterministicPrefs()`; one value across all OS |
| navigator.pdfViewerEnabled / plugins / mimeTypes (§1) | `pdfjs.disabled` gates `Navigator::PdfViewerEnabled`; plugin shape is a build-constant + RFPTarget `PdfjsSpoof`(20) | pin via `deterministicPrefs()`; the 5-entry PDF plugin shape is already OS-independent |
| UA client hints `Sec-CH-UA-*` / `navigator.userAgentData` (§1) | none — Firefox implements no UA client hints | default (absent) is already fleet-uniform; a positive surface needs a native emitter seeded from `VentoNavigator.clientHints()` — see `residualVariance()` |
| navigator/screen/timezone/fonts | `nsRFPService::GetSpoofed*` targets | `getSpoofedValues()` field |
| time zone / locale (§7) | `nsRFPService::GetSpoofedJSTimeZone()` / `GetSpoofedJSLocale()` (consumed at `js/xpconnect/src/nsXPConnect.cpp` `setTimeZoneOverride` / `setLocaleOverride`) | return `VentoTimeLocale.getSpoofedValues().timezone` / `.locale` per profile instead of the `Atlantic/Reykjavik` / `en-US` constants |
| Math ULP (§7) | RFPTarget `JSMathFdlibm`(23) | ENABLE via `overridesFragment()`; build-constant, no native patch |
| timer precision (§7) | `nsRFPService::ReduceTimePrecisionImpl` resolution + `nsRFPService::RandomMidpoint` seed | default: pin resolution + jitter off via `deterministicPrefs()` (deterministic floor). Optional jitter-on: seed `sSecretMidpointSeed` from `timerMidpointSeedHex()`; `quantizeTimerUs()` is the reference math |
| audio parameters (§5) | existing RFPTargets `AudioSampleRate`(39), `AudioContext`(49) + pref `media.cubeb.force_sample_rate` | ENABLE the targets via `overridesFragment()` + `deterministicPrefs()`; no native patch needed (build-constant 44100/2ch). Optional native pin of `AudioContext::OutputLatency()` (`dom/media/webaudio/AudioContext.cpp`) to `getSpoofedValues().outputLatency` for cross-OS identity — see `residualVariance()`. |
| audio DSP hash (§5) | `dom/media/webaudio/` buffer readback (ffvpx `av_tx` in `FFTBlock.h` + `DynamicsCompressor`) | build-constant for a same-build/same-SIMD fleet (Gecko adds no RFP noise here). Optional: force the scalar ffvpx kernel, or add `VentoAudio.perturbSamples()` output to the rendered buffer to mask cross-CPU SIMD divergence — see `residualVariance()`. |
| fonts: available list (§4) | existing RFPTargets `FontVisibilityBaseSystem`(43), `FontVisibilityLangPack`(44), `FontVisibilityRestrictGenerics`(62), `UseHardcodedFontSubstitutes`(69), `DOMStyleOsxFontSmoothing`(51) + pref `layout.css.font-visibility` | ENABLE the targets via `overridesFragment()` + pin `layout.css.font-visibility=1` via `deterministicPrefs()`; clamps each machine to its base tier (kills user-font entropy). Cross-OS-identical list needs the native remainder below. |
| fonts: whitelist → list (§4) | `gfxPlatformFontList::GetVisibilityForFamily` / the per-platform `StandardFonts-*.inc` base classification | return `FontVisibility::Base` iff `VentoFonts.isFontVisible(name)` and enumerate exactly `getSpoofedValues().fonts`, replacing the per-OS base list — see `residualVariance()` |
| fonts: glyph metrics (§4) | gfx/thebes shaping + gfx/2d text path | not pref-closeable; needs bundled profile font binaries + a deterministic software rasteriser shared with the §3 canvas-text PoC — see `residualVariance()` |
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
  own sibling test (`test_vento_audio.js`, `test_vento_fonts.js`,
  `test_vento_graphics.js`, `test_vento_input_devices.js`,
  `test_vento_misc_surfaces.js`, `test_vento_navigator.js`,
  `test_vento_network_fingerprint.js`,
  `test_vento_fingerprint_behavioral.js`, `test_vento_time_locale.js`) asserting
  the same two-machine identity plus that channel's mitigation.
- **E2E (hardware-dependent):** `vento-test-env/fingerprint/` — a CreepJS-style
  collector page plus a JSON snapshot comparator, run on two physically
  different stands (different GPU/OS) to catch hardware leaks the unit test
  cannot see (real canvas/WebGL/audio/TLS).
