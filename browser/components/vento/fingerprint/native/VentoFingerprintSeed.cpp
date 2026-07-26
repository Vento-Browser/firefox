/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "VentoFingerprintSeed.h"

#include "mozilla/Preferences.h"
#include "nsString.h"

namespace mozilla::vento {

// The pref that stores the master Vento fingerprint profile seed. Empty by
// default, which keeps Firefox's stock random-UUID behaviour.
static constexpr char kSeedPref[] = "vento.fingerprint.seed";

// Surface tag mixed into the session-key derivation. Keeps this key namespaced
// away from any other per-surface derivation that shares the same seed. Must
// stay in sync with the JS reference (VentoFingerprintProfile.sys.mjs).
static constexpr char kSessionSurface[] = "session";

// cyrb128 -- byte-for-byte port of the JS reference in
// browser/components/vento/fingerprint/VentoFingerprintProfile.sys.mjs.
// Produces four uint32 words of well-mixed, non-cryptographic hash. uint32
// arithmetic wraps mod 2^32, matching JS `Math.imul`, `^`, `>>>` on 32-bit
// values.
//
// The JS reference hashes the string's UTF-16 code units (charCodeAt); this
// port hashes the CString's bytes. Vento seeds are ASCII (hex/UUID), where the
// two are identical, so the C++ and JS derivations agree byte-for-byte.
static void Cyrb128(const nsACString& aStr, uint32_t aOut[4]) {
  uint32_t h1 = 1779033703u;
  uint32_t h2 = 3144134277u;
  uint32_t h3 = 1013904242u;
  uint32_t h4 = 2773480762u;

  const char* data = aStr.BeginReading();
  const uint32_t len = aStr.Length();
  for (uint32_t i = 0; i < len; i++) {
    uint32_t k = static_cast<uint8_t>(data[i]);
    h1 = h2 ^ ((h1 ^ k) * 597399067u);
    h2 = h3 ^ ((h2 ^ k) * 2869860233u);
    h3 = h4 ^ ((h3 ^ k) * 951274213u);
    h4 = h1 ^ ((h4 ^ k) * 2716044179u);
  }
  h1 = (h3 ^ (h1 >> 18)) * 597399067u;
  h2 = (h4 ^ (h2 >> 22)) * 2869860233u;
  h3 = (h1 ^ (h3 >> 17)) * 951274213u;
  h4 = (h2 ^ (h4 >> 19)) * 2716044179u;

  aOut[0] = h1 ^ h2 ^ h3 ^ h4;
  aOut[1] = h2 ^ h1;
  aOut[2] = h3 ^ h1;
  aOut[3] = h4 ^ h1;
}

// Pack four uint32 words into the 128 bits of an nsID. The layout is a fixed,
// canonical mapping (big-endian per word) -- it only needs to be stable and
// bijective so the same words always yield the same nsID.
static nsID WordsToID(const uint32_t aWords[4]) {
  nsID id;
  id.m0 = aWords[0];
  id.m1 = static_cast<uint16_t>(aWords[1] >> 16);
  id.m2 = static_cast<uint16_t>(aWords[1] & 0xffff);
  id.m3[0] = static_cast<uint8_t>(aWords[2] >> 24);
  id.m3[1] = static_cast<uint8_t>(aWords[2] >> 16);
  id.m3[2] = static_cast<uint8_t>(aWords[2] >> 8);
  id.m3[3] = static_cast<uint8_t>(aWords[2]);
  id.m3[4] = static_cast<uint8_t>(aWords[3] >> 24);
  id.m3[5] = static_cast<uint8_t>(aWords[3] >> 16);
  id.m3[6] = static_cast<uint8_t>(aWords[3] >> 8);
  id.m3[7] = static_cast<uint8_t>(aWords[3]);
  return id;
}

Maybe<nsID> DeriveSessionKey(const nsACString& aSeed,
                             const nsACString& aOASuffix) {
  if (aSeed.IsEmpty()) {
    return Nothing();
  }

  // Mirror the JS reference: cyrb128(`${seed} ${surface} ${origin}`).
  nsAutoCString input(aSeed);
  input.Append(' ');
  input.Append(kSessionSurface);
  input.Append(' ');
  input.Append(aOASuffix);

  uint32_t words[4];
  Cyrb128(input, words);
  return Some(WordsToID(words));
}

Maybe<nsID> DeterministicBrowsingSessionKey(const nsACString& aOASuffix) {
  nsAutoCString seed;
  if (NS_FAILED(Preferences::GetCString(kSeedPref, seed)) || seed.IsEmpty()) {
    return Nothing();
  }
  return DeriveSessionKey(seed, aOASuffix);
}

}  // namespace mozilla::vento
