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
  byte-identical seeds, noise streams and spoofed values.
- **E2E (hardware-dependent):** `vento-test-env/fingerprint/` — a CreepJS-style
  collector page plus a JSON snapshot comparator, run on two physically
  different stands (different GPU/OS) to catch hardware leaks the unit test
  cannot see (real canvas/WebGL/audio/TLS).
