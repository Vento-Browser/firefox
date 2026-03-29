/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * VentoLoginSyncService — ensures Firefox's built-in password store contains
 * no Vento credentials.  Passwords live exclusively on the Vento backend;
 * `about:logins` and the native autofill engine never see them.
 *
 * On startup and whenever the access token changes (login / logout / account
 * switch) the service removes all non-internal logins from Services.logins so
 * that any entries left over from a previous sync implementation are cleaned up.
 */

// Origins that must never be removed (internal Firefox / Vento machinery).
const EXCLUDED_ORIGIN_PREFIXES = [
  "chrome://",
  "resource://",
  "moz-extension://",
];

export const VentoLoginSyncService = {
  _initialized: false,
  _syncing: false,
  _prefObserver: null,

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    this._prefObserver = {
      observe: (_subject, _topic, data) => {
        if (data === "browser.logingate.accessToken") {
          this._wipeAllLocalLogins().catch(e =>
            console.error("VentoLoginSync: wipe failed:", e)
          );
        }
      },
    };
    Services.prefs.addObserver(
      "browser.logingate.accessToken",
      this._prefObserver
    );

    this._wipeAllLocalLogins().catch(e =>
      console.error("VentoLoginSync: startup wipe failed:", e)
    );
  },

  terminate() {
    if (this._prefObserver) {
      Services.prefs.removeObserver(
        "browser.logingate.accessToken",
        this._prefObserver
      );
      this._prefObserver = null;
    }
    this._initialized = false;
  },

  // ── Internal helpers ──────────────────────────────────────────────────────

  _shouldExclude(origin) {
    if (!origin) {
      return true;
    }
    return EXCLUDED_ORIGIN_PREFIXES.some(prefix => origin.startsWith(prefix));
  },

  async _wipeAllLocalLogins() {
    this._syncing = true;
    try {
      const allLogins = Services.logins.getAllLogins();
      for (const login of allLogins) {
        if (!this._shouldExclude(login.origin)) {
          try {
            await Services.logins.removeLoginAsync(login);
          } catch {}
        }
      }
    } finally {
      this._syncing = false;
    }
  },
};
