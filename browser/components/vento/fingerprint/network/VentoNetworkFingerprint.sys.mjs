/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Network/Protocol Fingerprint — the isolated, engine-agnostic core of
 * section 9 of FINGERPRINTING_RESEARCH.md (TLS JA3/JA4, HTTP/2 & HTTP/3 Akamai
 * fingerprint, HTTP header order, IP/ASN).
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree so it can
 * be lifted into a standalone repo, leaving behind only a couple of small,
 * documented injection points in Firefox/NSS core (see ./NETWORK_FINGERPRINT_POC.md
 * and ../README.md). Nothing here depends on Firefox internals — it is pure data:
 * a network profile in, a deterministic pref map out.
 *
 * Key PoC finding (proven against the tree, see NETWORK_FINGERPRINT_POC.md):
 * within one Vento build the wire fingerprint is ALREADY build-constant across
 * machines — the cipher/extension order (NSS never permutes, unlike Chrome), the
 * supported_groups/key_share, the HTTP/2 SETTINGS frame and its order, and the
 * request pseudo-header + header order are all fixed by the compiled code, not by
 * the host OS. What still differs between two machines running the same build is a
 * SMALL, enumerable set of knobs:
 *
 *   (a) per-connection randomness   — GREASE values, ECH-grease presence,
 *                                     probabilistic key shares;
 *   (b) per-host runtime state      — the TLS-intolerance downgrade cache;
 *   (c) prefs that a user/policy could have changed away from the build default.
 *
 * `deterministicPrefs()` pins (b) and (c) and the deterministic half of (a) so
 * every Vento machine emits an identical ClientHello + h2 fingerprint using only
 * prefs — no native patch. The irreducible remainder (random GREASE bytes, the
 * host TCP/IP stack) is returned verbatim by `residualVariance()` together with
 * the exact core hook that would close it. That split — "what a unified build +
 * proxy already gives" vs. "what needs an NSS/kernel patch" — is the deliverable.
 */

/**
 * NSS TLS version enum values as exposed through the security.tls.version.* prefs
 * (see security/manager/ssl / SSL_LIBRARY_VERSION_*): 1=TLS1.0 .. 4=TLS1.3.
 */
export const TLS = Object.freeze({
  TLS1_0: 1,
  TLS1_1: 2,
  TLS1_2: 3,
  TLS1_3: 4,
});

/**
 * The fleet-wide default network profile. Every value here MUST be identical on
 * every Vento install for the cross-machine guarantee to hold; that is the whole
 * point. The defaults mirror current desktop Firefox so a Vento client still
 * blends into the broader Firefox TLS/h2 population while being byte-identical
 * within the Vento cohort. Ship this frozen with the build; do not derive it from
 * anything host-specific.
 */
export const DEFAULT_NETWORK_PROFILE = Object.freeze({
  // --- TLS / ClientHello (JA3/JA4) ---
  tlsVersionMin: TLS.TLS1_2,
  tlsVersionMax: TLS.TLS1_3,
  // Pin the version-fallback limit to the max so the per-host intolerance cache
  // can never silently downgrade the ClientHello on one machine but not another.
  tlsFallbackLimit: TLS.TLS1_3,
  enableDeprecatedTls: false,
  // Post-quantum key shares dominate the JA4 key_share section — must match
  // fleet-wide. (security.tls.enable_kyber / enable_mlkem1024)
  enableKyber: true,
  enableMlkem1024: false,
  // security.tls.client_hello.send_p256_keyshare defaults to @IS_NOT_NIGHTLY_BUILD@,
  // i.e. it differs between a nightly and a release build. Pin it so a nightly and
  // a release Vento agree on the number of key shares in the ClientHello.
  sendP256Keyshare: true,
  // ECH-grease PRESENCE is decided per-connection by a coin flip against this
  // probability (nsNSSIOLayer.cpp). 0 or 100 both make it deterministic; the
  // greased payload BYTES still vary per connection but JA3/JA4 hash extension
  // *types*, not contents, so a fixed presence fully stabilises the JA4 `d`/`i`
  // extension digest. Pin to 100 to stay in the "Firefox-with-ECH-grease" cohort.
  echGreaseProbability: 100,
  echGreaseSize: 100,

  // --- HTTP/2 (Akamai h2 fingerprint) ---
  // These four together fully determine the SETTINGS frame (values + which
  // optional settings are present) and the priority setting; the SETTINGS entry
  // ORDER itself is hard-coded in Http2Session::SendHello and is not a pref.
  http2Enabled: true,
  http2EnabledDeps: true,
  http2SendNoRfc7540Pri: true,
  http2SendPushMaxConcurrent: false,
  http2HpackBufferBytes: 65536,

  // --- HTTP/3 ---
  http3Enabled: true,

  // --- Header order / locale ---
  // The request header ORDER is fixed by nsHttpHandler; only the Accept-Language
  // VALUE varies, and it must equal the fingerprint profile's locale, otherwise
  // TLS/h2 say "one machine" while a header says "another". This is the single
  // cross-reference between the network profile and VentoFingerprintProfile.
  acceptLanguage: "en-US, en;q=0.5",
});

/**
 * A network fingerprint. Constructed from a (partial) profile merged over
 * DEFAULT_NETWORK_PROFILE, so callers only override what the Vento panel exposes.
 */
export class VentoNetworkFingerprint {
  /**
   * @param {object} [profile] Partial overrides of DEFAULT_NETWORK_PROFILE.
   */
  constructor(profile = {}) {
    this.profile = Object.freeze({ ...DEFAULT_NETWORK_PROFILE, ...profile });
    const p = this.profile;
    if (p.tlsVersionMin > p.tlsVersionMax) {
      throw new Error("tlsVersionMin cannot exceed tlsVersionMax");
    }
    if (p.echGreaseProbability !== 0 && p.echGreaseProbability !== 100) {
      // Any value strictly between 0 and 100 re-introduces per-connection
      // presence randomness, defeating the whole module.
      throw new Error(
        "echGreaseProbability must be 0 or 100 for a deterministic ClientHello"
      );
    }
  }

  /**
   * The pref map that removes every in-build, machine-to-machine variance source
   * reachable from prefs. Applying exactly this map on two machines running the
   * same Vento build makes their ClientHello + HTTP/2 SETTINGS byte-identical
   * (modulo the residual native items below). Pref names are the real Firefox
   * pref names verified against the tree.
   *
   * @returns {Map<string, boolean|number|string>}
   */
  deterministicPrefs() {
    const p = this.profile;
    return new Map([
      // TLS version range + fallback (kills the per-host intolerance downgrade).
      ["security.tls.version.min", p.tlsVersionMin],
      ["security.tls.version.max", p.tlsVersionMax],
      ["security.tls.version.fallback-limit", p.tlsFallbackLimit],
      ["security.tls.version.enable-deprecated", p.enableDeprecatedTls],
      // ClientHello key_share / supported_groups.
      ["security.tls.enable_kyber", p.enableKyber],
      ["security.tls.enable_mlkem1024", p.enableMlkem1024],
      ["security.tls.client_hello.send_p256_keyshare", p.sendP256Keyshare],
      // ECH-grease presence -> deterministic.
      ["security.tls.ech_grease_probability", p.echGreaseProbability],
      ["security.tls.ech_grease_size", p.echGreaseSize],
      // HTTP/2 SETTINGS frame determinism.
      ["network.http.http2.enabled", p.http2Enabled],
      ["network.http.http2.enabled.deps", p.http2EnabledDeps],
      ["network.http.http2.send_NO_RFC7540_PRI", p.http2SendNoRfc7540Pri],
      [
        "network.http.http2.send_push_max_concurrent_frame",
        p.http2SendPushMaxConcurrent,
      ],
      ["network.http.http2.default-hpack-buffer", p.http2HpackBufferBytes],
      // HTTP/3.
      ["network.http.http3.enable", p.http3Enabled],
      // Accept-Language value (order is code-fixed). Must match the visual
      // fingerprint profile locale.
      ["intl.accept_languages", p.acceptLanguage],
    ]);
  }

  /**
   * A stable, human-auditable descriptor of everything that feeds JA3/JA4 and the
   * Akamai h2 fingerprint under this profile. This is NOT the literal JA4 hash —
   * that can only be read off the wire (see the measurement harness) because it
   * also encodes the exact compiled cipher/extension list. It IS a deterministic
   * function of the pinned knobs, so the harness can assert that two machines with
   * the same profile share this descriptor before it even trusts the wire capture,
   * and a change to it flags a fingerprint-affecting pref drift in review.
   *
   * @returns {string}
   */
  wireDescriptor() {
    const p = this.profile;
    const tls = [
      `v=${p.tlsVersionMin}-${p.tlsVersionMax}`,
      `fb=${p.tlsFallbackLimit}`,
      `kyber=${+p.enableKyber}`,
      `mlkem=${+p.enableMlkem1024}`,
      `p256=${+p.sendP256Keyshare}`,
      `echg=${p.echGreaseProbability}`,
    ].join(",");
    const h2 = [
      `hpack=${p.http2HpackBufferBytes}`,
      `push=${+p.http2SendPushMaxConcurrent}`,
      `norfc7540=${+p.http2SendNoRfc7540Pri}`,
    ].join(",");
    return `vento-net:tls{${tls}}|h2{${h2}}|h3=${+p.http3Enabled}|al=${p.acceptLanguage}`;
  }

  /**
   * The variance that `deterministicPrefs()` does NOT remove, each with the exact
   * core hook that would close it. This is the honest "needs a native patch"
   * half of the PoC verdict. Kept as data so ./NETWORK_FINGERPRINT_POC.md and the
   * test stay in sync with it.
   *
   * @returns {Array<{id:string, channel:string, whyNotPrefable:string,
   *   normalisedBy:string, injectionPoint:string}>}
   */
  residualVariance() {
    return [
      {
        id: "tls-grease-bytes",
        channel: "TLS ClientHello (raw JA3 only)",
        whyNotPrefable:
          "GREASE cipher/extension/PskKem values are drawn per-connection from " +
          "PK11_GenerateRandom, so raw JA3 (which hashes extension list contents) " +
          "changes every connection for EVERY Firefox, not just across machines. " +
          "JA4 already sorts+ignores GREASE, so JA4 is unaffected.",
        normalisedBy:
          "For JA4: nothing needed — GREASE is normalised out. For byte-identical " +
          "raw ClientHello: seed GREASE deterministically from the Vento profile " +
          "(or disable GREASE).",
        injectionPoint:
          "tls13_ClientSetupGrease() in security/nss/lib/ssl/tls13con.c — replace " +
          "the PK11_GenerateRandom(random,8) seed with a deterministic seed derived " +
          "from the profile (mirror VentoFingerprintProfile.surfaceSeedHex('tls-grease')).",
      },
      {
        id: "tls-intolerance-cache",
        channel: "TLS ClientHello (version + SCSV)",
        whyNotPrefable:
          "AdjustForTLSIntolerance() downgrades range.max and can add " +
          "TLS_FALLBACK_SCSV based on a per-host cache of past handshake failures, " +
          "which depends on each machine's browsing history.",
        normalisedBy:
          "Pinning security.tls.version.fallback-limit to version.max (done in " +
          "deterministicPrefs) makes any downgrade a no-op; additionally clear the " +
          "intolerance store on startup for a hard guarantee.",
        injectionPoint:
          "nsNSSIOLayer.cpp AdjustForTLSIntolerance / the IntoleranceStore — " +
          "already neutralised by the pinned fallback-limit; native hook optional.",
      },
      {
        id: "tcp-ip-stack",
        channel: "IP / TCP / QUIC transport (below the app)",
        whyNotPrefable:
          "SYN options (TTL/hop-limit, initial window, MSS, window scale, TCP " +
          "timestamps) and the source IP/ASN are produced by the host kernel, not " +
          "by Firefox, so no browser pref or NSS patch can equalise them.",
        normalisedBy:
          "vento_proxy: the origin server only ever sees the proxy's SYN and IP, " +
          "so the transport-layer fingerprint and geo/ASN are the proxy's, identical " +
          "for every Vento client sharing an egress. This is why the proxy is " +
          "load-bearing and why the profile timezone/locale must match proxy geo.",
        injectionPoint:
          "None in-browser. Enforced at the vento_proxy egress; keep TZ/locale of " +
          "the visual profile consistent with the proxy's geo.",
      },
    ];
  }
}
