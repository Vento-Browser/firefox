/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * In-memory cache of Vento credential metadata (no plaintext passwords).
 *
 * Syncs with the backend periodically so that VentoFormDetectorParent can
 * look up matching credentials for a given origin without making a network
 * request on every page load.
 *
 * Each cache entry: { guid: string, origin: string, username: string }
 *
 * The cache is intentionally read-only: creates/updates/deletes go through
 * the Vento panel UI and the backend REST API.
 */

const { setInterval, clearInterval } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const VentoLoginCache = {
  _entries: [],
  _timer: null,
  _initialized: false,

  /**
   * Start the cache and trigger an initial sync.
   * Safe to call multiple times.
   */
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._sync().catch(e =>
      console.error("VentoLoginCache: initial sync failed:", e)
    );
    this._timer = setInterval(
      () =>
        this._sync().catch(e =>
          console.error("VentoLoginCache: periodic sync failed:", e)
        ),
      SYNC_INTERVAL_MS
    );
  },

  terminate() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._entries = [];
    this._initialized = false;
  },

  /**
   * Force an immediate re-sync.
   * Called after a successful login in loginGate.html so the cache is
   * up to date before the user navigates to any target pages.
   *
   * @returns {Promise<void>}
   */
  invalidate() {
    return this._sync();
  },

  /**
   * Return all credentials whose stored URL hostname matches the given origin.
   *
   * @param {string} origin  e.g. "https://app.example.com"
   * @returns {{ guid: string, origin: string, username: string }[]}
   */
  findForOrigin(origin) {
    let queryHost;
    try {
      queryHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return [];
    }
    if (!queryHost) {
      return [];
    }

    return this._entries.filter(entry => {
      if (!entry.origin) {
        return false;
      }
      try {
        const entryUrl = /^https?:\/\//i.test(entry.origin)
          ? entry.origin
          : `https://${entry.origin}`;
        return new URL(entryUrl).hostname.toLowerCase() === queryHost;
      } catch {
        return false;
      }
    });
  },

  async _sync() {
    const serverUrl = Services.prefs.getStringPref(
      "browser.logingate.serverUrl",
      ""
    );
    const token = Services.prefs.getStringPref(
      "browser.logingate.accessToken",
      ""
    );
    if (!serverUrl || !token) {
      console.log(
        "[VentoLoginCache] _sync: skipped — serverUrl or token missing",
        { serverUrl: !!serverUrl, token: !!token }
      );
      return;
    }

    let res;
    try {
      res = await fetch(`${serverUrl}/api/browser-logins?page=1&per_page=500`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      console.error("[VentoLoginCache] _sync: fetch failed:", e);
      return;
    }

    if (!res.ok) {
      console.error("[VentoLoginCache] _sync: backend returned", res.status);
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.error("[VentoLoginCache] _sync: JSON parse failed:", e);
      return;
    }

    // Keep only credentials the user can actually fill: skip tombstones and
    // shares the backend marks hidden (its /value endpoint returns 403 for a
    // hidden login unless the caller owns it).
    this._entries = (data.logins ?? [])
      .filter(l => !l.deleted && !(l.is_hidden && !l.is_owner))
      .map(l => ({
        guid: l.guid,
        origin: l.origin ?? "",
        username: l.username ?? "",
      }));
    console.log(
      `[VentoLoginCache] _sync: loaded ${this._entries.length} entries`,
      this._entries.map(e => ({
        guid: e.guid,
        origin: e.origin,
        username: e.username,
      }))
    );
  },
};
