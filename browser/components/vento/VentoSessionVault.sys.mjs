/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_ACCESS_TOKEN = "browser.logingate.accessToken";
const PREF_SERVER_URL = "browser.logingate.serverUrl";

const VAULT_FILENAME = "vento-vault.bin";
const VAULT_MAGIC = new Uint8Array([0x56, 0x56, 0x4c, 0x54, 0x31]); // "VVLT1"
const GCM_IV_LENGTH = 12;
const MAX_HISTORY_VISITS = 50000;
const HISTORY_INSERT_CHUNK = 300;
// SessionStore only initializes once a browser window is created. If restore()
// runs before that ever happens, waiting on promiseInitialized would hang
// forever; give up on the tab restore (cookies/history are unaffected) after
// this long.
const SESSION_INIT_TIMEOUT_MS = 30000;

// Cache and form data are cleared but not preserved: restoring a cache is
// pointless and form data is not worth the vault size.
const SANITIZE_ITEMS = [
  "cache",
  "cookies",
  "offlineApps",
  "history",
  "formdata",
  "downloads",
  "sessions",
  "siteSettings",
];

const BLANK_BROWSER_STATE = JSON.stringify({
  windows: [{ tabs: [{ entries: [] }], selected: 1 }],
  selectedWindow: 1,
});

/**
 * Persists the user's browsing state (open tabs, cookies, history) across a
 * logout without leaving any of it readable on disk. On logout the state is
 * serialized, encrypted with a per-user AES-256-GCM key that only the backend
 * stores, and written to the profile; everything else is wiped via the
 * Sanitizer. On the next successful login the key is fetched again and the
 * state is restored. A different user logging in on the same machine gets a
 * different key, so the previous user's vault fails GCM authentication and is
 * discarded.
 */
export const VentoSessionVault = {
  _initialized: false,
  _keyBytes: null,
  _restoring: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.prefs.addObserver(PREF_ACCESS_TOKEN, () => {
      if (Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "")) {
        this._onLogin();
      }
    });
    if (Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "")) {
      this._onLogin();
    }
  },

  get _vaultPath() {
    return PathUtils.join(PathUtils.profileDir, VAULT_FILENAME);
  },

  async _onLogin() {
    try {
      await this._ensureKey();
    } catch (e) {
      console.error("VentoSessionVault: could not fetch profile key", e);
    }
    try {
      await this.restore();
    } catch (e) {
      console.error("VentoSessionVault: restore failed", e);
    }
  },

  /**
   * Fetches (and caches) the per-user vault key from the backend. Requires a
   * valid access token, so it must be called before the token is cleared.
   */
  async _ensureKey() {
    if (this._keyBytes) {
      return this._keyBytes;
    }
    const token = Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "");
    const server = Services.prefs.getStringPref(PREF_SERVER_URL, "");
    if (!token || !server) {
      throw new Error("not logged in");
    }
    const res = await fetch(`${server}/api/auth/profile-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`profile-key request failed with ${res.status}`);
    }
    const { profile_key } = await res.json();
    if (!/^[0-9a-f]{64}$/.test(profile_key)) {
      throw new Error("malformed profile key");
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(profile_key.substr(i * 2, 2), 16);
    }
    this._keyBytes = bytes;
    return bytes;
  },

  async _importKey(usage) {
    const bytes = await this._ensureKey();
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
  },

  /**
   * Captures tabs, cookies and history and writes them encrypted to the
   * profile directory. Must run while the access token is still valid.
   *
   * @returns {boolean} true if a vault file was written. When the key cannot
   *          be obtained (e.g. server unreachable and nothing cached) nothing
   *          is written — the caller should still clear the data; losing the
   *          session is preferable to leaving it on disk.
   */
  async seal() {
    let key;
    try {
      key = await this._importKey("encrypt");
    } catch (e) {
      console.error("VentoSessionVault: sealing skipped, no key", e);
      return false;
    }
    const payload = {
      version: 1,
      createdAt: Date.now(),
      session: this._captureSession(),
      cookies: this._captureCookies(),
      history: await this._captureHistory(),
    };
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data)
    );
    const out = new Uint8Array(
      VAULT_MAGIC.length + iv.length + ciphertext.length
    );
    out.set(VAULT_MAGIC, 0);
    out.set(iv, VAULT_MAGIC.length);
    out.set(ciphertext, VAULT_MAGIC.length + iv.length);
    await IOUtils.write(this._vaultPath, out, {
      tmpPath: `${this._vaultPath}.tmp`,
    });
    return true;
  },

  _captureSession() {
    try {
      return lazy.SessionStore.getBrowserState();
    } catch (e) {
      // SessionStore is not initialized before the first browser window
      // exists (e.g. logout from the startup login gate).
      return null;
    }
  },

  _captureCookies() {
    const cookies = [];
    for (const c of Services.cookies.cookies) {
      cookies.push({
        host: c.host,
        path: c.path,
        name: c.name,
        value: c.value,
        isSecure: c.isSecure,
        isHttpOnly: c.isHttpOnly,
        isSession: c.isSession,
        expiry: c.expiry,
        originAttributes: c.originAttributes,
        sameSite: c.sameSite,
        schemeMap: c.schemeMap,
        isPartitioned: c.isPartitioned,
      });
    }
    return cookies;
  },

  async _captureHistory() {
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const rows = await db.execute(
        `SELECT p.url AS url, p.title AS title,
                v.visit_date AS date, v.visit_type AS type
         FROM moz_places p
         JOIN moz_historyvisits v ON v.place_id = p.id
         ORDER BY v.visit_date DESC
         LIMIT ${MAX_HISTORY_VISITS}`
      );
      return rows.map(r => ({
        url: r.getResultByName("url"),
        title: r.getResultByName("title"),
        date: r.getResultByName("date"),
        type: r.getResultByName("type"),
      }));
    } catch (e) {
      console.error("VentoSessionVault: history capture failed", e);
      return [];
    }
  },

  /**
   * Wipes all browsing data. Called after seal() and after the access token
   * has been cleared, so a failure in seal() never blocks the wipe.
   */
  async clearBrowsingData() {
    this._keyBytes = null;
    try {
      lazy.SessionStore.setBrowserState(BLANK_BROWSER_STATE);
    } catch (e) {
      // No browser window yet (startup gate) — nothing visible to close.
    }
    await lazy.Sanitizer.sanitize(SANITIZE_ITEMS, { ignoreTimespan: true });
  },

  /**
   * Decrypts the vault (if present) with the current user's key and restores
   * cookies, history and the tab session. A vault sealed by a different user
   * fails GCM authentication and is deleted. When the key is temporarily
   * unavailable the vault is kept for a later attempt.
   */
  async restore() {
    if (this._restoring) {
      return;
    }
    this._restoring = true;
    try {
      if (!(await IOUtils.exists(this._vaultPath))) {
        return;
      }
      const raw = await IOUtils.read(this._vaultPath);
      if (
        raw.length < VAULT_MAGIC.length + GCM_IV_LENGTH ||
        !VAULT_MAGIC.every((b, i) => raw[i] === b)
      ) {
        await IOUtils.remove(this._vaultPath, { ignoreAbsent: true });
        return;
      }
      let key;
      try {
        key = await this._importKey("decrypt");
      } catch (e) {
        return;
      }
      let payload;
      try {
        const iv = raw.subarray(
          VAULT_MAGIC.length,
          VAULT_MAGIC.length + GCM_IV_LENGTH
        );
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          raw.subarray(VAULT_MAGIC.length + GCM_IV_LENGTH)
        );
        payload = JSON.parse(new TextDecoder().decode(plain));
      } catch (e) {
        await IOUtils.remove(this._vaultPath, { ignoreAbsent: true });
        return;
      }
      this._restoreCookies(payload.cookies ?? []);
      await this._restoreHistory(payload.history ?? []);
      await IOUtils.remove(this._vaultPath, { ignoreAbsent: true });
      await this._restoreSession(payload.session);
    } finally {
      this._restoring = false;
    }
  },

  _restoreCookies(cookies) {
    for (const c of cookies) {
      try {
        Services.cookies.add(
          c.host,
          c.path,
          c.name,
          c.value,
          c.isSecure,
          c.isHttpOnly,
          c.isSession,
          c.expiry,
          c.originAttributes ?? {},
          c.sameSite,
          c.schemeMap,
          c.isPartitioned
        );
      } catch (e) {
        // Skip cookies that fail validation.
      }
    }
  },

  async _restoreHistory(visits) {
    const validTransitions = new Set(
      Object.values(lazy.PlacesUtils.history.TRANSITIONS)
    );
    const byUrl = new Map();
    for (const v of visits) {
      if (!v.url) {
        continue;
      }
      let entry = byUrl.get(v.url);
      if (!entry) {
        try {
          Services.io.newURI(v.url);
        } catch (e) {
          continue;
        }
        entry = { url: v.url, title: v.title || undefined, visits: [] };
        byUrl.set(v.url, entry);
      }
      entry.visits.push({
        date: new Date(Math.max(0, Math.floor((v.date || 0) / 1000))),
        transition: validTransitions.has(v.type)
          ? v.type
          : lazy.PlacesUtils.history.TRANSITIONS.LINK,
      });
    }
    const pageInfos = [...byUrl.values()];
    for (let i = 0; i < pageInfos.length; i += HISTORY_INSERT_CHUNK) {
      const chunk = pageInfos.slice(i, i + HISTORY_INSERT_CHUNK);
      try {
        await lazy.PlacesUtils.history.insertMany(chunk);
      } catch (e) {
        for (const pageInfo of chunk) {
          try {
            await lazy.PlacesUtils.history.insert(pageInfo);
          } catch (inner) {
            // Skip entries Places rejects.
          }
        }
      }
    }
  },

  async _restoreSession(state) {
    if (!state) {
      return;
    }
    let timer;
    const timeout = new Promise(resolve => {
      timer = lazy.setTimeout(resolve, SESSION_INIT_TIMEOUT_MS);
    });
    try {
      const initialized = await Promise.race([
        lazy.SessionStore.promiseInitialized.then(() => true),
        timeout,
      ]);
      if (!initialized) {
        console.error(
          "VentoSessionVault: SessionStore did not initialize in time, skipping tab restore"
        );
        return;
      }
      lazy.SessionStore.setBrowserState(state);
    } finally {
      lazy.clearTimeout(timer);
    }
  },
};
