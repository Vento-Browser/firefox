/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActorParent — runs in the parent (browser) process.
 *
 * Implements directFill(), which is called directly from vento-page.mjs
 * (same process — this is a direct method call, not an IPC message).
 *
 * Flow:
 *   1. Fetch the plaintext password from the backend (HTTPS, parent process).
 *   2. Forward the plaintext and username to VentoPasswordChild via IPC.
 *   3. VentoPasswordChild fills the password field and shows a credential chip.
 */

export class VentoPasswordParent extends JSWindowActorParent {
  /**
   * Fetch the credential secret and forward it directly to the content process.
   *
   * Called directly from vento-page.mjs (same parent process).
   *
   * @param {object} opts
   * @param {number} opts.credentialId     Password record id on the backend.
   * @param {string} opts.username         Username to fill into the login field.
   * @param {string} opts.credentialTitle  Credential name shown in the chip UI.
   * @param {string} opts.apiBase          Backend base URL, e.g. "https://…".
   * @param {string} opts.bearerToken      JWT for authenticating the API call.
   * @returns {Promise<{filled: boolean, reason?: string}>}
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
}
