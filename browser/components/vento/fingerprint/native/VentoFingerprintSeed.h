/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_vento_VentoFingerprintSeed_h
#define mozilla_vento_VentoFingerprintSeed_h

#include "mozilla/Maybe.h"
#include "nsID.h"
#include "nsStringFwd.h"

/**
 * Vento deterministic-identity native injection point.
 *
 * This is the ONE core patch documented in
 * browser/components/vento/fingerprint/README.md: Firefox salts canvas/WebGL/
 * audio randomization with a random per-session UUID
 * (nsRFPService::GetBrowsingSessionKey -> nsID::GenerateUUID()). To make the
 * salted noise byte-identical across machines that share a Vento fingerprint
 * profile, that random UUID is replaced with a value derived deterministically
 * from the profile seed.
 *
 * Everything Vento-specific lives in this isolated module so it can be lifted
 * into a standalone repo, leaving only the one-line call in nsRFPService
 * behind. The derivation (cyrb128) is a byte-for-byte port of the JS reference
 * in fingerprint/VentoFingerprintProfile.sys.mjs, so the C++ session key
 * matches the JS module's `sessionKeyId()` for the same (seed, suffix).
 */
namespace mozilla::vento {

/**
 * Derive the browsing-session key deterministically from the configured Vento
 * fingerprint profile seed (pref `vento.fingerprint.seed`) and the given
 * origin-attributes suffix.
 *
 * @param aOASuffix  The origin-attributes suffix identifying the browsing
 *                   context (already partition-keyed by the caller).
 * @return Some(nsID) when a non-empty Vento seed is configured; Nothing when no
 *         seed is set, in which case the caller keeps Firefox's default random
 *         UUID behaviour.
 */
Maybe<nsID> DeterministicBrowsingSessionKey(const nsACString& aOASuffix);

/**
 * The core derivation, exposed for testing. Produces a deterministic nsID from
 * an explicit seed and suffix. An empty seed yields Nothing.
 */
Maybe<nsID> DeriveSessionKey(const nsACString& aSeed,
                             const nsACString& aOASuffix);

}  // namespace mozilla::vento

#endif  // mozilla_vento_VentoFingerprintSeed_h
