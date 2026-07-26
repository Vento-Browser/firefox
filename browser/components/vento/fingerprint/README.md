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
| profile storage/sync | Vento panel + backend component | `export()` / `import()` |

## How determinism is tested

- **Unit / CI (deterministic):**
  `browser/components/tests/unit/test_vento_fingerprint_determinism.js` builds
  two independent profiles from the same data ("two machines") and asserts
  byte-identical seeds, noise streams and spoofed values.
- **E2E (hardware-dependent):** `vento-test-env/fingerprint/` — a CreepJS-style
  collector page plus a JSON snapshot comparator, run on two physically
  different stands (different GPU/OS) to catch hardware leaks the unit test
  cannot see (real canvas/WebGL/audio/TLS).
