/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * VentoLoginSyncService — Firefox password-manager sync via Vento account.
 *
 * Implements the same data model as the Firefox Sync password engine
 * (guid-identified nsILoginInfo + nsILoginMetaInfo records with
 * `time_password_changed` as the conflict-resolution clock) but uses the
 * Vento backend (`POST /api/browser-logins/sync`) instead of Mozilla
 * Sync/FxA infrastructure.
 *
 * Authentication: the JWT stored in `browser.logingate.accessToken` (written
 * by loginGate.html on successful login) is sent as a Bearer token on every
 * request — no Mozilla account required.
 *
 * Sync protocol (bi-directional, single round-trip):
 *   1. Client collects all current local logins (non-deleted).
 *   2. Client POSTs them to /api/browser-logins/sync.
 *   3. Server upserts each with last-write-wins on time_password_changed,
 *      then returns its full view (including tombstones).
 *   4. Client applies the diff:
 *      - Record absent locally → addLoginAsync
 *      - Record newer on server → modifyLoginAsync
 *      - Tombstone (deleted=true) present locally → removeLoginAsync
 *
 * Deletion propagation:
 *   When the `passwordmgr-storage-changed` observer fires with "removeLogin"
 *   the service immediately calls DELETE /api/browser-logins/{guid} to
 *   create a server-side tombstone.  This ensures cross-device deletion
 *   works even when the periodic sync fires after the removal.
 *
 * Loop-guard: all writes to Services.logins that originate from this service
 * are wrapped in a `_syncing = true` guard; the storage observer is ignored
 * while this flag is set.
 */

const { setTimeout, clearTimeout, setInterval, clearInterval } =
  ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const PUSH_DEBOUNCE_MS = 2_000;           // coalesce rapid local changes
const LAST_SYNC_PREF   = "browser.vento.login_sync.last_sync_ms";

// Origins that must never be synced (internal Firefox / Vento machinery).
const EXCLUDED_ORIGIN_PREFIXES = [
  "chrome://",
  "resource://",
  "moz-extension://",
];

export const VentoLoginSyncService = {
  _initialized: false,
  _syncing: false,         // true while we are applying server data locally
  _pushTimer: null,        // debounce handle for add/modify events
  _periodicTimer: null,
  _observer: null,

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    this._observer = {
      observe: (subject, topic, data) => {
        if (topic !== "passwordmgr-storage-changed" || this._syncing) {
          return;
        }
        if (data === "removeLogin") {
          // Push deletion immediately so the tombstone reaches the server
          // before the login disappears from local storage.
          try {
            subject.QueryInterface(Ci.nsILoginMetaInfo);
            this._pushDeletion(subject.guid).catch(e =>
              console.error("VentoLoginSync: deletion push failed:", e)
            );
          } catch {
            // subject may not be an nsILoginInfo in edge cases; ignore.
          }
        } else if (data === "addLogin" || data === "modifyLogin") {
          this._schedulePush();
        }
      },
    };
    Services.obs.addObserver(this._observer, "passwordmgr-storage-changed");

    // Initial sync: pull any logins added on other devices.
    this._sync().catch(e =>
      console.error("VentoLoginSync: initial sync failed:", e)
    );

    // Periodic background sync.
    this._periodicTimer = setInterval(
      () =>
        this._sync().catch(e =>
          console.error("VentoLoginSync: periodic sync failed:", e)
        ),
      SYNC_INTERVAL_MS
    );
  },

  terminate() {
    if (this._observer) {
      Services.obs.removeObserver(this._observer, "passwordmgr-storage-changed");
      this._observer = null;
    }
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
    }
    this._initialized = false;
  },

  // ── Internal helpers ──────────────────────────────────────────────────────

  _getCredentials() {
    const serverUrl = Services.prefs.getStringPref(
      "browser.logingate.serverUrl",
      ""
    );
    const token = Services.prefs.getStringPref(
      "browser.logingate.accessToken",
      ""
    );
    if (!serverUrl || !token) {
      return null;
    }
    return { serverUrl, token };
  },

  _shouldExclude(origin) {
    if (!origin) {
      return true;
    }
    return EXCLUDED_ORIGIN_PREFIXES.some(prefix => origin.startsWith(prefix));
  },

  /** Coalesce rapid add/modify events into a single sync after a short delay. */
  _schedulePush() {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
    }
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this._sync().catch(e =>
        console.error("VentoLoginSync: push sync failed:", e)
      );
    }, PUSH_DEBOUNCE_MS);
  },

  /**
   * Convert an nsILoginInfo (+ nsILoginMetaInfo) to the wire record format
   * expected by the backend.
   */
  _loginToRecord(login) {
    login.QueryInterface(Ci.nsILoginMetaInfo);
    return {
      guid: login.guid,
      origin: login.origin,
      form_action_origin: login.formActionOrigin || null,
      http_realm: login.httpRealm || null,
      username: login.username,
      password: login.password,
      username_field: login.usernameField || "",
      password_field: login.passwordField || "",
      time_created: login.timeCreated || 0,
      time_last_used: login.timeLastUsed || 0,
      time_password_changed: login.timePasswordChanged || 0,
      times_used: login.timesUsed || 0,
      unknown_fields: login.unknownFields || null,
      deleted: false,
    };
  },

  // ── Sync ──────────────────────────────────────────────────────────────────

  async _sync() {
    const creds = this._getCredentials();
    if (!creds) {
      return; // Not logged in yet.
    }
    const { serverUrl, token } = creds;

    // Collect local logins, filtering out internal browser origins.
    let localLogins;
    try {
      localLogins = await Services.logins.getAllLogins();
    } catch (e) {
      console.error("VentoLoginSync: getAllLogins failed:", e);
      return;
    }
    const eligibleLogins = localLogins.filter(
      l => !this._shouldExclude(l.origin)
    );
    const localRecords = eligibleLogins.map(l => this._loginToRecord(l));

    // POST to /api/browser-logins/sync.
    let data;
    try {
      const res = await fetch(`${serverUrl}/api/browser-logins/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ logins: localRecords }),
      });
      if (!res.ok) {
        console.error("VentoLoginSync: server returned", res.status);
        return;
      }
      data = await res.json();
    } catch (e) {
      console.error("VentoLoginSync: fetch failed:", e);
      return;
    }

    // Build a guid → local login map for O(1) look-up.
    const localByGuid = new Map();
    for (const l of eligibleLogins) {
      l.QueryInterface(Ci.nsILoginMetaInfo);
      localByGuid.set(l.guid, l);
    }

    // Apply the server's response under the loop-guard.
    this._syncing = true;
    try {
      for (const record of data.logins) {
        if (record.deleted) {
          // Server holds a tombstone — remove locally if present.
          const existing = localByGuid.get(record.guid);
          if (existing) {
            try {
              await Services.logins.removeLoginAsync(existing);
            } catch (e) {
              console.error(
                "VentoLoginSync: removeLoginAsync failed for",
                record.guid,
                e
              );
            }
          }
          continue;
        }

        const existing = localByGuid.get(record.guid);
        if (!existing) {
          // New login from another device — add locally.
          try {
            const login = Cc[
              "@mozilla.org/login-manager/loginInfo;1"
            ].createInstance(Ci.nsILoginInfo);
            login.init(
              record.origin,
              record.form_action_origin ?? null,
              record.http_realm ?? null,
              record.username,
              record.password,
              record.username_field ?? "",
              record.password_field ?? ""
            );
            login.QueryInterface(Ci.nsILoginMetaInfo);
            login.guid                = record.guid;
            login.timeCreated         = record.time_created        || Date.now();
            login.timeLastUsed        = record.time_last_used       || Date.now();
            login.timePasswordChanged = record.time_password_changed || Date.now();
            login.timesUsed           = record.times_used           || 0;
            if (record.unknown_fields) {
              login.unknownFields = record.unknown_fields;
            }
            await Services.logins.addLoginAsync(login);
          } catch (e) {
            console.error(
              "VentoLoginSync: addLoginAsync failed for",
              record.guid,
              e
            );
          }
        } else if (
          record.time_password_changed > existing.timePasswordChanged
        ) {
          // Server has a newer version — update the local record.
          try {
            const updated = Cc[
              "@mozilla.org/login-manager/loginInfo;1"
            ].createInstance(Ci.nsILoginInfo);
            updated.init(
              record.origin,
              record.form_action_origin ?? null,
              record.http_realm ?? null,
              record.username,
              record.password,
              record.username_field ?? "",
              record.password_field ?? ""
            );
            updated.QueryInterface(Ci.nsILoginMetaInfo);
            updated.guid                = record.guid;
            updated.timeCreated         = record.time_created;
            updated.timeLastUsed        = record.time_last_used;
            updated.timePasswordChanged = record.time_password_changed;
            updated.timesUsed           = record.times_used;
            if (record.unknown_fields) {
              updated.unknownFields = record.unknown_fields;
            }
            await Services.logins.modifyLoginAsync(existing, updated);
          } catch (e) {
            console.error(
              "VentoLoginSync: modifyLoginAsync failed for",
              record.guid,
              e
            );
          }
        }
        // else: local version is same age or newer — already pushed; no-op.
      }
    } finally {
      this._syncing = false;
    }

    Services.prefs.setStringPref(
      LAST_SYNC_PREF,
      String(data.server_time_ms)
    );
    console.log(
      `VentoLoginSync: sync complete — server returned ${data.logins.length} records`
    );
  },

  /**
   * Create a server-side tombstone immediately after a local removal.
   *
   * Uses DELETE /api/browser-logins/{guid} which sets `deleted=TRUE` with
   * the current server timestamp as the conflict clock.  If the deletion
   * loses a conflict (another device re-added the login more recently) the
   * tombstone is silently ignored by the server's upsert logic.
   */
  async _pushDeletion(guid) {
    const creds = this._getCredentials();
    if (!creds) {
      return;
    }
    const { serverUrl, token } = creds;
    try {
      const res = await fetch(
        `${serverUrl}/api/browser-logins/${encodeURIComponent(guid)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) {
        console.error("VentoLoginSync: DELETE returned", res.status, "for", guid);
      }
    } catch (e) {
      console.error("VentoLoginSync: DELETE fetch failed for", guid, e);
    }
  },
};
