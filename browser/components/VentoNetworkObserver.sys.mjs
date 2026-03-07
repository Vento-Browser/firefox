/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process HTTP request observer.
 *
 * Listens for "http-on-modify-request" notifications and replaces any Vento
 * fill tokens found in the request body with the corresponding plaintext
 * password.  The plaintext never crosses the parent ↔ content IPC boundary;
 * only the opaque token does.
 *
 * Token formats in request bodies:
 *   Plain (JSON, text/plain):    VENTO_CRED:<UUID>
 *   URL-encoded (form POST):     VENTO_CRED%3A<UUID>   (':' → %3A)
 *
 * Security properties:
 *   - The token is bound to the credential's origin.  If the outgoing request
 *     targets a different origin, resolve() returns null and the token is left
 *     in the body as-is (useless to the attacker).
 *   - Each token is one-shot; resolve() deletes it before returning.
 *   - Password bytes are zeroed in the credential service after retrieval.
 *
 * DevTools note:
 *   This observer fires during "http-on-modify-request".  DevTools'
 *   NetworkObserver fires on the same topic.  Because our observer is
 *   registered first (at browser startup), it runs first and the DevTools
 *   panel may show the substituted body.  The X-Vento-Fill header added
 *   below can be used by a DevTools patch to suppress body logging for
 *   secure-fill requests; the header is removed before the request is sent.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VentoCredentialService:
    "chrome://browser/content/vento/VentoCredentialService.sys.mjs",
});

// UUID pattern: 8-4-4-4-12 lowercase hex digits.
const UUID_PAT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Token in plain form — appears in JSON bodies and other non-encoded formats.
 */
const TOKEN_RE_PLAIN = new RegExp(`VENTO_CRED:${UUID_PAT}`, "gi");

/**
 * Token in percent-encoded form — appears in application/x-www-form-urlencoded
 * bodies (the ':' character is encoded as %3A).
 */
const TOKEN_RE_ENC = new RegExp(`VENTO_CRED%3A${UUID_PAT}`, "gi");

/** HTTP methods that may carry a request body. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export const VentoNetworkObserver = {
  _initialized: false,

  /**
   * Register the HTTP observer and start the credential service sweep timer.
   * Safe to call multiple times.
   */
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.obs.addObserver(this, "http-on-modify-request", /* weak= */ true);
    lazy.VentoCredentialService.init();
  },

  // nsIObserver ──────────────────────────────────────────────────────────────

  observe(subject, topic) {
    if (topic !== "http-on-modify-request") {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }

    // Only process methods that carry a body.
    let method;
    try {
      method = channel.requestMethod.toUpperCase();
    } catch {
      return;
    }
    if (!BODY_METHODS.has(method)) {
      return;
    }

    let uploadChannel;
    try {
      uploadChannel = channel.QueryInterface(Ci.nsIUploadChannel2);
    } catch {
      return;
    }

    const uploadStream = uploadChannel.uploadStream;
    if (!uploadStream) {
      return;
    }

    // Seek to position 0 before reading.
    // nsIStringInputStream (used for form/JSON/XHR bodies) implements
    // nsISeekableStream.  Non-seekable streams (e.g. file uploads) are not
    // modified.
    let seekable = null;
    try {
      seekable = uploadStream.QueryInterface(Ci.nsISeekableStream);
      seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
    } catch {
      seekable = null;
    }

    const scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    scriptable.init(uploadStream);

    let available;
    try {
      available = scriptable.available();
    } catch {
      return;
    }
    if (!available) {
      return;
    }

    // Read the body as a binary string (one JS char per byte, values 0–255).
    let body;
    try {
      body = scriptable.read(available);
    } catch {
      return;
    }

    // Seek back to 0 so the HTTP handler can re-read the body if we skip it.
    // If the seek fails the stream was not seekable; we will replace it below.
    let soughtBack = false;
    if (seekable) {
      try {
        seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
        soughtBack = true;
      } catch {
        soughtBack = false;
      }
    }

    // Fast path: skip regex work when there is no token in this body.
    if (!body.includes("VENTO_CRED")) {
      if (!soughtBack) {
        // Non-seekable stream was consumed — put the original data back.
        this._setStream(uploadChannel, body, method, channel);
      }
      return;
    }

    let requestOrigin;
    try {
      requestOrigin = channel.URI.prePath; // "https://example.com"
    } catch {
      return;
    }

    let contentType = "";
    try {
      contentType = channel.getRequestHeader("Content-Type");
    } catch {}
    const mediaType = contentType.split(";")[0].trim();
    const isUrlEncoded = mediaType === "application/x-www-form-urlencoded";
    const isJson = mediaType === "application/json";

    const modifiedBody = isUrlEncoded
      ? this._substituteUrlEncoded(body, requestOrigin)
      : this._substitutePlain(body, requestOrigin, isJson);

    if (modifiedBody === null) {
      // No valid token found or origin mismatch — leave the body unchanged.
      if (!soughtBack) {
        this._setStream(uploadChannel, body, method, channel);
      }
      return;
    }

    // Mark the request so a patched DevTools observer can suppress body
    // logging.  We remove the header after substitution so it is not sent.
    try {
      channel.setRequestHeader("X-Vento-Fill", "1", false);
    } catch {}

    this._setStream(uploadChannel, modifiedBody, method, channel);

    try {
      channel.setRequestHeader("X-Vento-Fill", "", false);
    } catch {}
  },

  // ── Body substitution ──────────────────────────────────────────────────────

  /**
   * Replace tokens in an application/x-www-form-urlencoded body.
   *
   * The ':' in the token name is percent-encoded as %3A (case-insensitive).
   *
   * @param {string} body
   * @param {string} requestOrigin
   * @returns {string|null}  Modified body, or null when no substitution occurred.
   */
  _substituteUrlEncoded(body, requestOrigin) {
    let changed = false;
    const result = body.replace(TOKEN_RE_ENC, match => {
      // Decode "%3A" → ":" to reconstruct the full token key.
      const token = match.replace(/%3A/i, ":");
      const bytes = lazy.VentoCredentialService.resolve(token, requestOrigin);
      if (!bytes) {
        return match; // expired, unknown, or origin mismatch — leave as-is
      }
      changed = true;
      const plaintext = new TextDecoder().decode(bytes);
      bytes.fill(0);
      // URL-encode the password so it is safe in a form-urlencoded body.
      // encodeURIComponent handles non-ASCII via UTF-8 percent-encoding.
      return encodeURIComponent(plaintext);
    });
    return changed ? result : null;
  },

  /**
   * Replace tokens in a plain or JSON body.
   *
   * @param {string}  body
   * @param {string}  requestOrigin
   * @param {boolean} isJson  When true, the replacement is JSON-escaped.
   * @returns {string|null}
   */
  _substitutePlain(body, requestOrigin, isJson) {
    let changed = false;
    const result = body.replace(TOKEN_RE_PLAIN, match => {
      const bytes = lazy.VentoCredentialService.resolve(match, requestOrigin);
      if (!bytes) {
        return match;
      }
      changed = true;
      const plaintext = new TextDecoder().decode(bytes);
      bytes.fill(0);
      if (isJson) {
        // Escape for safe embedding inside a JSON string value.
        // All non-ASCII and control characters are rendered as \uXXXX so the
        // replacement remains pure ASCII (safe for binary body concatenation).
        return this._jsonEscapeAsciiSafe(plaintext);
      }
      return plaintext;
    });
    return changed ? result : null;
  },

  /**
   * Escape a string for embedding as a JSON string value.
   *
   * All characters outside ASCII printable range (and JSON special chars) are
   * replaced with \uXXXX escapes, keeping the result pure ASCII so it can be
   * safely concatenated into a binary body string.
   *
   * @param {string} str
   * @returns {string}
   */
  _jsonEscapeAsciiSafe(str) {
    return str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\u0000-\u001f\u007f-\uffff]/g, ch =>
        "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
      );
  },

  // ── Stream helpers ─────────────────────────────────────────────────────────

  /**
   * Replace the channel's upload stream with new body data.
   *
   * @param {nsIUploadChannel2} uploadChannel
   * @param {string}            body    Binary string (one char = one byte).
   * @param {string}            method  HTTP method ("POST", "PUT", …).
   * @param {nsIHttpChannel}    channel Original channel (for Content-Type).
   */
  _setStream(uploadChannel, body, method, channel) {
    let mediaType = "";
    try {
      mediaType = channel.getRequestHeader("Content-Type").split(";")[0].trim();
    } catch {}

    const newStream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
      Ci.nsIStringInputStream
    );
    // setData() treats the JS string as a binary string (one char = one byte).
    newStream.setData(body, body.length);

    try {
      uploadChannel.explicitSetUploadStream(
        newStream,
        mediaType,
        body.length,
        method,
        /* aStreamHasHeaders= */ false
      );
    } catch (e) {
      console.error("VentoNetworkObserver: failed to replace upload stream:", e);
    }
  },

  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsISupportsWeakReference",
  ]),
};
