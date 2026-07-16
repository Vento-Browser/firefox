/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-process HTTP body interceptor for Vento secure autofill.
 *
 * Content processes only ever see an opaque fill token
 * ("VENTO_CRED:<UUID>", issued by VentoCredentialService). When the login
 * form is submitted, this observer rewrites the outgoing request body,
 * replacing the token with the real password bytes — but only when the
 * request goes to the origin the credential is bound to. A token leaking to
 * any other host goes out as the useless token string, never as the password.
 *
 * Handles both raw occurrences (multipart, JSON) and percent-encoded ones
 * (application/x-www-form-urlencoded, where ":" is sent as "%3A").
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  VentoCredentialService:
    "chrome://browser/content/vento/VentoCredentialService.sys.mjs",
});

const TOKEN_RE = /VENTO_CRED(?::|%3[Aa])[0-9a-fA-F-]{36}/g;

export const VentoNetworkObserver = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.obs.addObserver(this, "http-on-modify-request");
  },

  terminate() {
    if (!this._initialized) {
      return;
    }
    Services.obs.removeObserver(this, "http-on-modify-request");
    this._initialized = false;
  },

  observe(subject, topic) {
    if (topic !== "http-on-modify-request") {
      return;
    }
    try {
      this._maybeRewrite(subject);
    } catch (e) {
      console.error("[VentoNetworkObserver] rewrite failed:", e);
    }
  },

  _maybeRewrite(subject) {
    if (!(subject instanceof Ci.nsIHttpChannel)) {
      return;
    }
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (!(channel instanceof Ci.nsIUploadChannel)) {
      return;
    }

    const body = this._readBody(channel);
    if (!body || !body.includes("VENTO_CRED")) {
      return;
    }

    const requestHost = channel.URI.host;
    const resolved = new Map();
    let substituted = false;

    const newBody = body.replace(TOKEN_RE, match => {
      const encoded = !match.includes(":");
      const token =
        "VENTO_CRED:" + match.slice(match.length - 36).toLowerCase();

      let plaintext;
      if (resolved.has(token)) {
        plaintext = resolved.get(token);
      } else {
        plaintext = lazy.VentoCredentialService.resolve(
          token,
          `https://${requestHost}`
        );
        resolved.set(token, plaintext);
      }
      if (plaintext === null) {
        return match;
      }
      substituted = true;
      return encoded
        ? encodeURIComponent(plaintext)
        : this._toByteString(plaintext);
    });

    if (substituted) {
      this._setBody(channel, newBody);
    }
  },

  /**
   * Read the upload stream as a byte string, rewinding so necko can still
   * send it if we end up not modifying the request.
   *
   * @param {nsIHttpChannel} channel
   */
  _readBody(channel) {
    const stream = channel.uploadStream;
    if (!stream || !(stream instanceof Ci.nsISeekableStream)) {
      return null;
    }
    try {
      stream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
      const data = lazy.NetUtil.readInputStreamToString(
        stream,
        stream.available()
      );
      stream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
      return data;
    } catch {
      return null;
    }
  },

  _setBody(channel, byteString) {
    let contentType = "";
    try {
      contentType = channel.getRequestHeader("Content-Type");
    } catch {
      // No Content-Type header on the original request.
    }
    const method = channel.requestMethod;

    const bodyStream = Cc[
      "@mozilla.org/io/string-input-stream;1"
    ].createInstance(Ci.nsIStringInputStream);
    bodyStream.setByteStringData(byteString);

    channel
      .QueryInterface(Ci.nsIUploadChannel2)
      .explicitSetUploadStream(bodyStream, contentType, -1, method, false);

    // explicitSetUploadStream keeps a pre-existing Content-Length header
    // as-is. The substituted body has a different length, so the stale value
    // would make the server wait for bytes that never come (or truncate).
    channel.setRequestHeader(
      "Content-Length",
      String(byteString.length),
      false
    );
  },

  /**
   * UTF-8-encode a JS string into the byte-string domain used by
   * nsIStringInputStream.setByteStringData().
   *
   * @param {string} str
   */
  _toByteString(str) {
    return String.fromCharCode(...new TextEncoder().encode(str));
  },
};
