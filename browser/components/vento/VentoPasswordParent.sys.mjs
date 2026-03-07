/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActorParent — runs in the parent (browser) process.
 *
 * Implements secureFill(), which is called directly from vento-page.mjs
 * (same process — this is a direct method call, not an IPC message).
 *
 * Flow:
 *   1. Fetch the plaintext password from the backend (HTTPS, parent process).
 *   2. Issue an opaque fill token via VentoCredentialService; the plaintext
 *      is stored as zeroable bytes and never leaves the parent process.
 *   3. Forward only the token and username to VentoPasswordChild via IPC.
 *   4. VentoNetworkObserver intercepts the outgoing HTTP request and
 *      substitutes the token with the real password at the network layer.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VentoCredentialService:
    "chrome://browser/content/vento/VentoCredentialService.sys.mjs",
});

export class VentoPasswordParent extends JSWindowActorParent {
  /**
   * Fetch the credential secret, issue a fill token, and forward it to the
   * content process.  The plaintext never crosses the IPC boundary.
   *
   * Called directly from vento-page.mjs (same parent process).
   *
   * @param {object} opts
   * @param {number} opts.credentialId   Password record id on the backend.
   * @param {string} opts.username       Username to fill into the login field.
   * @param {string} opts.allowedUrl     Target URL (used for origin binding).
   * @param {string} opts.apiBase        Backend base URL, e.g. "https://…".
   * @param {string} opts.bearerToken    JWT for authenticating the API call.
   * @returns {Promise<{filled: boolean, reason?: string}>}
   */
  /**
   * Like secureFill(), but sends the real password directly to the content
   * process instead of an opaque token.  Use this when the caller needs
   * input.value to contain the actual password (e.g. context-menu fill).
   * The plaintext crosses the IPC boundary, so this is less secure than
   * secureFill() but allows normal form interaction.
   */
  async directFill({ credentialId, username, credentialTitle, apiBase, bearerToken }) {
    let plaintext;
    try {
      const resp = await fetch(
        `${apiBase}/api/passwords/${credentialId}/value`,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      plaintext = data.value;
    } catch (e) {
      return { filled: false, reason: `fetch-error: ${e.message}` };
    }

    try {
      return await this.sendQuery("VentoPassword:DirectFill", {
        username,
        fillToken: plaintext,
        credentialTitle: credentialTitle ?? "",
      });
    } catch (e) {
      return { filled: false, reason: `send-error: ${e.message}` };
    } finally {
      plaintext = null;
    }
  }

  async secureFill({ credentialId, username, allowedUrl, apiBase, bearerToken }) {
    // ── Step 1: Fetch the secret in the parent process ────────────────────
    let plaintext;
    try {
      const resp = await fetch(
        `${apiBase}/api/passwords/${credentialId}/value`,
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      plaintext = data.value;
    } catch (e) {
      return { filled: false, reason: `fetch-error: ${e.message}` };
    }

    // ── Step 2: Issue a fill token ────────────────────────────────────────
    // The plaintext is encoded to a Uint8Array inside issueToken() and the
    // string reference is dropped here immediately after.
    lazy.VentoCredentialService.init();
    const fillToken = lazy.VentoCredentialService.issueToken(
      plaintext,
      allowedUrl,
      this.browsingContext.id
    );
    plaintext = null; // drop reference; bytes live only in the service's Map

    // ── Step 3: Send only the token to the content process ────────────────
    try {
      return await this.sendQuery("VentoPassword:Fill", { username, fillToken });
    } catch (e) {
      // Content process is gone (tab closed, navigated) — revoke the token.
      lazy.VentoCredentialService.revokeContext(this.browsingContext.id);
      return { filled: false, reason: `send-error: ${e.message}` };
    }
  }
}
