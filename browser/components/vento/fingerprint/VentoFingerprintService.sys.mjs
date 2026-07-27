/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Vento Fingerprint Service — the browser-side of backend profile delivery and
 * the one place that actually writes a composed profile into `Services.prefs`.
 *
 * Design goal (Gleb): keep ALL Vento fingerprint logic in this subtree, isolated
 * enough to lift into a standalone repo. The backend half of "выдача/синхронизация
 * профиля" is a separate deployable component (contract in
 * ../docs/FINGERPRINT_BACKEND.md, by the pattern of vento_license / vento_feedback);
 * this module is its thin, testable Firefox client:
 *
 *   fetchRemote / pushRemote   talk to that backend over the documented REST shape
 *   loadLocal / saveLocal      cache the active profile in a single pref
 *   applyProfile               turn a profile into prefs via VentoFingerprintComposer
 *                              and write them, so the browser reflects the profile
 *   sync                       pull -> import/migrate -> cache -> apply, one call
 *
 * Every external dependency (the pref branch, `fetch`) is injected with a sane
 * default so the whole flow is unit-testable in xpcshell against a mock backend
 * and a scratch pref branch, with no network and no live nsRFPService.
 */

import { VentoFingerprintProfile } from "resource:///modules/fingerprint/VentoFingerprintProfile.sys.mjs";
import { VentoFingerprintComposer } from "resource:///modules/fingerprint/VentoFingerprintComposer.sys.mjs";

/** The single pref that caches the active profile as serialized JSON. */
export const ACTIVE_PROFILE_PREF = "vento.fingerprint.profile.json";
/** Pref carrying the backend base URL for profile sync. */
export const API_BASE_PREF = "vento.fingerprint.api.url";

/**
 *
 */
export class VentoFingerprintService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.prefs]  Something with get/set string prefs. Defaults to
   *   Services.prefs. Only string prefs are used for the cache; `applyProfile`
   *   dispatches by value type.
   * @param {Function} [deps.fetch]  Defaults to the global fetch.
   */
  constructor({ prefs, fetch: fetchImpl } = {}) {
    this.prefs =
      prefs ?? (typeof Services !== "undefined" ? Services.prefs : undefined);
    this.fetch =
      fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  }

  /**
   * Read the cached active profile, or null if none is stored. A stored payload is
   * migrated forward on read, so an older cache still yields a current profile.
   *
   * @returns {VentoFingerprintProfile|null}
   */
  loadLocal() {
    const json = this.#getString(ACTIVE_PROFILE_PREF, "");
    if (!json) {
      return null;
    }
    return VentoFingerprintProfile.import(JSON.parse(json));
  }

  /**
   * Cache a profile as JSON in the active-profile pref.
   *
   * @param {VentoFingerprintProfile} profile  The profile to cache.
   */
  saveLocal(profile) {
    this.#setString(ACTIVE_PROFILE_PREF, JSON.stringify(profile.export()));
  }

  /**
   * Write the profile's composed pref map into the pref store. This is the step
   * that makes the browser reflect the profile: it fans the composer's Map out to
   * the right typed pref setter. Returns the applied Map for inspection/logging.
   *
   * @param {VentoFingerprintProfile} profile  The profile to apply.
   * @returns {Map<string, string|number|boolean>}
   */
  applyProfile(profile) {
    const prefs = VentoFingerprintComposer.composePrefs(profile);
    for (const [key, value] of prefs) {
      switch (typeof value) {
        case "boolean":
          this.prefs.setBoolPref(key, value);
          break;
        case "number":
          this.prefs.setIntPref(key, value | 0);
          break;
        default:
          this.#setString(key, String(value));
          break;
      }
    }
    return prefs;
  }

  /**
   * GET the active profile from the backend. The backend returns the serialized
   * profile shape ({version, seed, label, fields}); we import/migrate it so a
   * server on an older format still yields a current profile.
   *
   * @param {string} apiBase  The backend base URL.
   * @param {string} token  The bearer token for authorization.
   * @returns {Promise<VentoFingerprintProfile>}
   */
  async fetchRemote(apiBase, token) {
    const res = await this.fetch(
      `${trimSlash(apiBase)}/api/fingerprint/profile`,
      {
        method: "GET",
        headers: authHeaders(token),
      }
    );
    if (!res.ok) {
      throw new Error(`fingerprint profile fetch failed: HTTP ${res.status}`);
    }
    return VentoFingerprintProfile.import(await res.json());
  }

  /**
   * PUT a profile to the backend (e.g. after editing it in the panel). Sends the
   * versioned serialized shape so the server can migrate/store it.
   *
   * @param {string} apiBase  The backend base URL.
   * @param {string} token  The bearer token for authorization.
   * @param {VentoFingerprintProfile} profile  The profile to push.
   * @returns {Promise<void>}
   */
  async pushRemote(apiBase, token, profile) {
    const res = await this.fetch(
      `${trimSlash(apiBase)}/api/fingerprint/profile`,
      {
        method: "PUT",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(profile.export()),
      }
    );
    if (!res.ok) {
      throw new Error(`fingerprint profile push failed: HTTP ${res.status}`);
    }
  }

  /**
   * Full pull path: fetch the profile from the backend, cache it locally and apply
   * it to prefs. One call for BrowserGlue startup / a panel "Sync now" button.
   *
   * @param {string} apiBase  The backend base URL.
   * @param {string} token  The bearer token for authorization.
   * @returns {Promise<VentoFingerprintProfile>}
   */
  async sync(apiBase, token) {
    const profile = await this.fetchRemote(apiBase, token);
    this.saveLocal(profile);
    this.applyProfile(profile);
    return profile;
  }

  #getString(key, fallback) {
    if (!this.prefs) {
      return fallback;
    }
    return this.prefs.getStringPref(key, fallback);
  }

  #setString(key, value) {
    this.prefs.setStringPref(key, value);
  }
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, "");
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
