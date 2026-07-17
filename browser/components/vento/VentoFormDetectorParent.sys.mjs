/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActorParent — runs in the parent (browser) process.
 *
 * Receives a page origin from VentoFormDetectorChild, looks up matching
 * credentials in VentoLoginCache, fetches the plaintext from the backend,
 * issues a one-shot fill token, and forwards only the token to the child.
 *
 * The plaintext password is fetched and tokenised entirely in the parent
 * process — it never crosses the IPC boundary.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VentoCredentialService:
    "chrome://browser/content/vento/VentoCredentialService.sys.mjs",
  VentoLoginCache: "chrome://browser/content/vento/VentoLoginCache.sys.mjs",
});

/**
 *
 */
export class VentoFormDetectorParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name !== "VentoFormDetector:LookupCredentials") {
      return undefined;
    }

    const { origin } = message.data;
    console.log("[VentoFormDetector] LookupCredentials for", origin);

    // ── Step 1: Find a matching credential in the local cache ────────────
    // If the cache is completely empty it probably hasn't finished its first
    // sync yet (startup race: _sync() is async and BrowserGlue doesn't await
    // it).  Force one sync attempt before giving up.
    let entries = lazy.VentoLoginCache.findForOrigin(origin);
    console.log(
      `[VentoFormDetector] cache has ${lazy.VentoLoginCache._entries.length} total entries, ${entries.length} match origin`
    );

    if (!entries.length && !lazy.VentoLoginCache._entries.length) {
      console.log("[VentoFormDetector] cache empty — forcing sync");
      try {
        await lazy.VentoLoginCache.invalidate();
      } catch (e) {
        console.error("[VentoFormDetector] forced sync failed:", e);
        return undefined;
      }
      entries = lazy.VentoLoginCache.findForOrigin(origin);
      console.log(
        `[VentoFormDetector] after sync: ${lazy.VentoLoginCache._entries.length} total, ${entries.length} match`
      );
    }
    if (!entries.length) {
      console.log("[VentoFormDetector] no matching credential for", origin);
      return undefined;
    }

    // Use the first matching credential.  Multiple matches are possible when
    // several passwords share the same domain; for now we pick the first.
    // A future improvement could show a picker UI similar to the native
    // login dropdown.
    const entry = entries[0];
    console.log(
      "[VentoFormDetector] using entry guid:",
      entry.guid,
      "origin:",
      entry.origin
    );

    const serverUrl = Services.prefs.getStringPref(
      "browser.logingate.serverUrl",
      ""
    );
    const bearerToken = Services.prefs.getStringPref(
      "browser.logingate.accessToken",
      ""
    );
    if (!serverUrl || !bearerToken) {
      console.error("[VentoFormDetector] serverUrl or bearerToken missing");
      return undefined;
    }

    // ── Step 2: Fetch the plaintext from the backend (parent process) ────
    let plaintext;
    try {
      const res = await fetch(
        `${serverUrl}/api/browser-logins/${entry.guid}/value`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      );
      if (!res.ok) {
        console.error(
          "[VentoFormDetector] backend /value returned",
          res.status
        );
        return undefined;
      }
      const data = await res.json();
      plaintext = data.value;
    } catch (e) {
      console.error("[VentoFormDetector] fetch /value failed:", e);
      return undefined;
    }

    if (!plaintext) {
      console.error("[VentoFormDetector] backend returned empty value");
      return undefined;
    }

    // ── Step 3: Issue a one-shot fill token ──────────────────────────────
    lazy.VentoCredentialService.init();
    const allowedUrl = entry.origin || origin;
    const bcId = this.browsingContext?.id ?? 0;

    let fillToken;
    try {
      fillToken = lazy.VentoCredentialService.issueToken(
        plaintext,
        allowedUrl,
        bcId
      );
    } catch (e) {
      console.error("[VentoFormDetector] issueToken failed:", e);
      return undefined;
    } finally {
      // Drop the JS string reference immediately; the bytes live only inside
      // VentoCredentialService's Map as a Uint8Array.
      plaintext = null;
    }

    console.log(
      "[VentoFormDetector] token issued, sending FillCredentials to child"
    );

    // ── Step 4: Forward only the token to the content process ────────────
    try {
      this.sendAsyncMessage("VentoFormDetector:FillCredentials", {
        username: entry.username,
        fillToken,
      });
    } catch (e) {
      // The child is already gone (navigation, tab close) — revoke the token
      // so it does not linger in the credential store.
      console.error(
        "[VentoFormDetector] sendAsyncMessage failed (child gone?):",
        e
      );
      lazy.VentoCredentialService.revokeContext(bcId);
    }

    return undefined;
  }
}
