/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"

#include "mozilla/vento/VentoFingerprintSeed.h"
#include "nsString.h"

using namespace mozilla;
using namespace mozilla::vento;

// No seed configured => Nothing, so nsRFPService keeps the stock random UUID.
TEST(VentoFingerprintSeed, EmptySeedYieldsNothing)
{
  EXPECT_TRUE(DeriveSessionKey(""_ns, ""_ns).isNothing());
  EXPECT_TRUE(DeriveSessionKey(""_ns, "^userContextId=1"_ns).isNothing());
}

// The whole point: two independent derivations from the same (seed, suffix)
// -- i.e. "two machines with the same profile" -- produce the byte-identical
// session key. A different seed or suffix produces a different key.
TEST(VentoFingerprintSeed, Determinism)
{
  auto a = DeriveSessionKey("shared-profile-seed"_ns, "^firstPartyDomain=x"_ns);
  auto b = DeriveSessionKey("shared-profile-seed"_ns, "^firstPartyDomain=x"_ns);
  ASSERT_TRUE(a.isSome());
  ASSERT_TRUE(b.isSome());
  EXPECT_TRUE(a.ref().Equals(b.ref()));

  auto otherSeed =
      DeriveSessionKey("different-seed"_ns, "^firstPartyDomain=x"_ns);
  ASSERT_TRUE(otherSeed.isSome());
  EXPECT_FALSE(a.ref().Equals(otherSeed.ref()));

  auto otherSuffix =
      DeriveSessionKey("shared-profile-seed"_ns, "^firstPartyDomain=y"_ns);
  ASSERT_TRUE(otherSuffix.isSome());
  EXPECT_FALSE(a.ref().Equals(otherSuffix.ref()));
}

// Golden vectors locking the derivation to the JS reference
// (VentoFingerprintProfile.sys.mjs cyrb128 of `${seed} session ${suffix}`).
// If the C++ port ever drifts from the JS module these fail, guarding the
// byte-for-byte cross-implementation guarantee.
TEST(VentoFingerprintSeed, MatchesJsReference)
{
  auto k1 = DeriveSessionKey("test-seed"_ns, ""_ns);
  ASSERT_TRUE(k1.isSome());
  EXPECT_STREQ(k1.ref().ToString().get(),
               "{3539ee32-9915-7812-bd79-20631155b643}");

  auto k2 =
      DeriveSessionKey("vento-default-profile-v1"_ns, "^userContextId=1"_ns);
  ASSERT_TRUE(k2.isSome());
  EXPECT_STREQ(k2.ref().ToString().get(),
               "{cb55f5f4-50c4-6968-2700-bafdbc912661}");
}
