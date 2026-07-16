/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process-only store of short-lived fill tokens.
 *
 * A fill token is an opaque string ("VENTO_CRED:<UUID>") that stands in for a
 * plaintext password. The token is what crosses IPC into the content process
 * and what page JS can observe in the password field; the password bytes stay
 * in this module until VentoNetworkObserver swaps them into the outgoing HTTP
 * request body.
 *
 * Token properties: one-shot (deleted on first successful resolve), 60 s TTL,
 * bound to the credential's origin (resolve fails for any other request
 * origin), password bytes zeroed after use or expiry.
 */

import {
  setInterval,
  clearInterval,
} from "resource://gre/modules/Timer.sys.mjs";

export const TOKEN_PREFIX = "VENTO_CRED:";
const TOKEN_TTL_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

function hostnameOf(urlish) {
  if (!urlish) {
    return "";
  }
  try {
    const spec = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlish)
      ? urlish
      : `https://${urlish}`;
    return new URL(spec).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export const VentoCredentialService = {
  /** @type {Map<string, {bytes: Uint8Array, host: string, browsingContextId: number, expiry: number}>} */
  _tokens: new Map(),
  _timer: null,
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._timer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
  },

  terminate() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const token of [...this._tokens.keys()]) {
      this._drop(token);
    }
    this._initialized = false;
  },

  /**
   * Store a plaintext secret and return the opaque token standing in for it.
   *
   * @param {string} plaintext        The password to protect.
   * @param {string} allowedUrl       Origin/URL the credential is bound to.
   * @param {number} browsingContextId Context that requested the fill.
   * @returns {string} the fill token ("VENTO_CRED:<UUID>")
   */
  issueToken(plaintext, allowedUrl, browsingContextId) {
    if (!plaintext) {
      throw new Error("VentoCredentialService: empty plaintext");
    }
    const host = hostnameOf(allowedUrl);
    if (!host) {
      throw new Error(
        `VentoCredentialService: cannot derive host from "${allowedUrl}"`
      );
    }
    this.init();
    const uuid = Services.uuid.generateUUID().toString().slice(1, -1);
    const token = TOKEN_PREFIX + uuid;
    this._tokens.set(token, {
      bytes: new TextEncoder().encode(plaintext),
      host,
      browsingContextId: browsingContextId ?? 0,
      expiry: Date.now() + TOKEN_TTL_MS,
    });
    return token;
  },

  /**
   * Exchange a token for its plaintext. One-shot: a successful resolve
   * deletes the token and zeroes the stored bytes.
   *
   * @param {string} token         The fill token found in a request body.
   * @param {string} requestOrigin Origin (or URL) the request is going to.
   * @returns {string|null} the plaintext, or null when the token is unknown,
   *   expired, or bound to a different origin.
   */
  resolve(token, requestOrigin) {
    const entry = this._tokens.get(token);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiry) {
      this._drop(token);
      return null;
    }
    if (hostnameOf(requestOrigin) !== entry.host) {
      console.warn(
        `[VentoCredentialService] resolve refused: request host ` +
          `"${hostnameOf(requestOrigin)}" does not match bound host ` +
          `"${entry.host}"`
      );
      return null;
    }
    const plaintext = new TextDecoder().decode(entry.bytes);
    this._drop(token);
    return plaintext;
  },

  /**
   * Revoke every token issued for the given browsing context.
   *
   * @param {number} browsingContextId
   */
  revokeContext(browsingContextId) {
    for (const [token, entry] of this._tokens) {
      if (entry.browsingContextId === browsingContextId) {
        this._drop(token);
      }
    }
  },

  _drop(token) {
    const entry = this._tokens.get(token);
    if (entry) {
      entry.bytes.fill(0);
      this._tokens.delete(token);
    }
  },

  _sweep() {
    const now = Date.now();
    for (const [token, entry] of this._tokens) {
      if (now > entry.expiry) {
        this._drop(token);
      }
    }
  },
};
