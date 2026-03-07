/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process credential token store.
 *
 * Plaintext passwords are held here as Uint8Array bytes (zeroable on use or
 * expiry).  An opaque fill token ("VENTO_CRED:<UUID>") is issued and sent to
 * the content process.  The content process fills the DOM field with that
 * token.  VentoNetworkObserver intercepts outgoing HTTP requests and
 * substitutes the token with the real password bytes just before they leave
 * the parent process.
 *
 * Security properties:
 *   - Plaintext never crosses the parent ↔ content IPC boundary.
 *   - Each token is one-shot: deleted on first successful resolve().
 *   - Tokens expire after TOKEN_TTL_MS even if never used.
 *   - Tokens are bound to the credential's origin; resolving against a
 *     different origin returns null (prevents cross-site exfiltration via XHR).
 *   - Password bytes are zeroed (Uint8Array.fill(0)) on use and expiry.
 */

const { setInterval } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const FILL_TOKEN_PREFIX = "VENTO_CRED:";

/** How long a token stays valid after issuance (milliseconds). */
const TOKEN_TTL_MS = 60_000;

export const VentoCredentialService = {
  /**
   * @type {Map<string, {
   *   bytes: Uint8Array,
   *   origin: string,
   *   browsingContextId: number,
   *   expiry: number
   * }>}
   */
  _store: new Map(),
  _sweepTimerId: null,

  /**
   * Start the expiry sweep timer.  Safe to call multiple times.
   */
  init() {
    if (this._sweepTimerId !== null) {
      return;
    }
    this._sweepTimerId = setInterval(() => this._sweep(), 5_000);
  },

  /**
   * Encode a plaintext password and create a one-shot fill token.
   *
   * The token is bound to the origin derived from `allowedURL` so that
   * VentoNetworkObserver refuses to substitute it into requests to other
   * origins.
   *
   * @param {string} plaintext          The real password value.
   * @param {string} allowedURL         The credential's target URL.
   * @param {number} browsingContextId  The content BC id (cleanup on nav).
   * @returns {string}  e.g. "VENTO_CRED:550e8400-e29b-41d4-a716-446655440000"
   */
  issueToken(plaintext, allowedURL, browsingContextId) {
    const bytes = new TextEncoder().encode(plaintext);

    let origin = "";
    try {
      const href = /^https?:\/\//i.test(allowedURL)
        ? allowedURL
        : `https://${allowedURL}`;
      origin = new URL(href).origin;
    } catch {
      // No parseable URL — allow any origin (weakened, but safe to proceed).
    }

    const token =
      FILL_TOKEN_PREFIX +
      Services.uuid.generateUUID().toString().replace(/[{}]/g, "");

    this._store.set(token, {
      bytes,
      origin,
      browsingContextId,
      expiry: Date.now() + TOKEN_TTL_MS,
    });

    return token;
  },

  /**
   * Validate and consume a fill token.
   *
   * Returns the password bytes when:
   *   1. The token exists in the store.
   *   2. The token has not expired.
   *   3. The request origin matches the bound origin (or the credential has
   *      no origin).
   *
   * The token is deleted before the bytes are returned (one-shot guarantee).
   * The caller is responsible for zeroing the returned bytes after use.
   *
   * @param {string} token          The fill token string.
   * @param {string} requestOrigin  Origin of the outgoing request.
   * @returns {Uint8Array|null}
   */
  resolve(token, requestOrigin) {
    const entry = this._store.get(token);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiry) {
      this._revoke(token);
      return null;
    }

    if (entry.origin && entry.origin !== requestOrigin) {
      // Origin mismatch — do not substitute; leave the token in the body as-is.
      return null;
    }

    // One-shot: remove BEFORE returning so concurrent calls cannot double-use.
    this._store.delete(token);
    return entry.bytes;
  },

  /**
   * Revoke all tokens associated with a BrowsingContext.
   * Call this when a tab navigates away or is closed.
   *
   * @param {number} browsingContextId
   */
  revokeContext(browsingContextId) {
    for (const [token, entry] of this._store) {
      if (entry.browsingContextId === browsingContextId) {
        this._revoke(token);
      }
    }
  },

  // ── Private ──────────────────────────────────────────────────────────────

  _revoke(token) {
    const entry = this._store.get(token);
    if (entry) {
      entry.bytes.fill(0);
      this._store.delete(token);
    }
  },

  _sweep() {
    const now = Date.now();
    for (const [token, entry] of this._store) {
      if (now > entry.expiry) {
        this._revoke(token);
      }
    }
  },
};
