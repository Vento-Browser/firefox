/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VentoSessionVault: "chrome://browser/content/vento/VentoSessionVault.sys.mjs",
});

const PREF_ACCESS_TOKEN = "browser.logingate.accessToken";

// Notified (data = "required" | "done") whenever the login state changes.
// Each browser window observes this to show/hide its in-window login overlay
// (gVentoLoginOverlay in browser-init.js), which frames the login gate page.
const TOPIC_LOGIN_CHANGED = "vento-login-changed";

/**
 * Single entry point for authentication. Any Vento component that gets a 401
 * from the backend calls promptReauth() instead of showing the login gate
 * itself, so concurrent failures produce a single in-window login overlay.
 * Like the lock overlay, the login gate is painted inside every browser window
 * rather than in a separate modal window that could float above other
 * applications or be closed to reveal the tabs behind it.
 */
export const VentoAuth = {
  _loginRequired: false,
  _loginWaiters: [],

  get token() {
    return Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "");
  },

  get loginRequired() {
    return this._loginRequired;
  },

  /**
   * Requests the login gate. Shows the login overlay in every open browser
   * window; windows opened while login is required paint it on startup.
   *
   * @returns {Promise<boolean>} resolves true once the user completes login
   *          (the login page calls notifyLoggedIn). The overlay cannot be
   *          dismissed, so it never resolves false.
   */
  requireLogin() {
    if (!this._loginRequired) {
      this._loginRequired = true;
      Services.obs.notifyObservers(null, TOPIC_LOGIN_CHANGED, "required");
    }
    return new Promise(resolve => this._loginWaiters.push(resolve));
  },

  /**
   * Called by the login gate page once a new session is established (a valid
   * access token was written). Hides the overlay in every window and resolves
   * every pending requireLogin()/promptReauth() promise.
   */
  notifyLoggedIn() {
    if (!this._loginRequired) {
      return;
    }
    this._loginRequired = false;
    Services.obs.notifyObservers(null, TOPIC_LOGIN_CHANGED, "done");
    const waiters = this._loginWaiters;
    this._loginWaiters = [];
    for (const resolve of waiters) {
      try {
        resolve(true);
      } catch {}
    }
  },

  /**
   * Shows the in-window login overlay and resolves once the user re-logs in.
   * Callers that got a 401 use this instead of showing a gate themselves, so
   * concurrent failures share a single overlay.
   *
   * @returns {Promise<boolean>} resolves true once login completes.
   */
  promptReauth() {
    return this.requireLogin();
  },

  /**
   * Full logout: seals the browsing state into the encrypted vault (while the
   * token is still valid), clears the token, wipes all browsing data, and —
   * unless promptLogin is false — shows the login overlay and waits for the
   * user to log back in.
   *
   * @param {object} [options]
   * @param {boolean} [options.promptLogin=true] false when the caller manages
   *        the login UI itself (lock overlay, login overlay).
   * @returns {Promise<boolean>} true if the user logged back in.
   */
  async logout({ promptLogin = true } = {}) {
    try {
      await lazy.VentoSessionVault.seal();
    } catch (e) {
      console.error("VentoAuth: vault seal failed", e);
    }
    Services.prefs.clearUserPref(PREF_ACCESS_TOKEN);
    try {
      await lazy.VentoSessionVault.clearBrowsingData();
    } catch (e) {
      console.error("VentoAuth: browsing data wipe failed", e);
    }
    if (!promptLogin) {
      return false;
    }
    return this.requireLogin();
  },
};
