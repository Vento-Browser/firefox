/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  VentoAuth: "chrome://browser/content/vento/VentoAuth.sys.mjs",
});

const PREF_ACCESS_TOKEN = "browser.logingate.accessToken";
// Seconds of user inactivity before the browser locks; 0 disables idle lock.
const PREF_IDLE_SECONDS = "browser.vento.lock.idleSeconds";
const DEFAULT_IDLE_SECONDS = 600;

/**
 * Locks the browser UI after a period of inactivity (or on demand) behind an
 * app-modal lock window. Unlocking requires OS-level authentication
 * (Touch ID / Windows Hello / account password) via OSKeyStore.
 */
export const VentoLockService = {
  _initialized: false,
  _locked: false,
  _idleSeconds: 0,
  _idleService: null,
  _idleObserver: null,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._idleService = Cc["@mozilla.org/widget/useridleservice;1"].getService(
      Ci.nsIUserIdleService
    );
    this._idleObserver = {
      observe: (_subject, topic) => {
        if (topic === "idle") {
          this.lock();
        }
      },
    };
    this._applyIdlePref();
    Services.prefs.addObserver(PREF_IDLE_SECONDS, () => this._applyIdlePref());
  },

  _applyIdlePref() {
    const seconds = Services.prefs.getIntPref(
      PREF_IDLE_SECONDS,
      DEFAULT_IDLE_SECONDS
    );
    if (this._idleSeconds > 0) {
      this._idleService.removeIdleObserver(
        this._idleObserver,
        this._idleSeconds
      );
      this._idleSeconds = 0;
    }
    if (seconds > 0) {
      this._idleService.addIdleObserver(this._idleObserver, seconds);
      this._idleSeconds = seconds;
    }
  },

  get locked() {
    return this._locked;
  },

  /**
   * Opens the app-modal lock window and blocks until it is closed. If the
   * user chose "Sign out" inside the lock window (the access token is gone
   * afterwards), the login gate is shown next.
   */
  lock() {
    if (this._locked) {
      return;
    }
    this._locked = true;
    try {
      // Tab contents must not be visible behind the lock window.
      lazy.VentoAuth.withBrowserWindowsHidden(() =>
        Services.ww.openWindow(
          null,
          "chrome://browser/content/lockGate.html",
          "_blank",
          "chrome,centerscreen,modal,resizable=no,width=460,height=320",
          null
        )
      );
    } finally {
      this._locked = false;
    }
    if (!Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "")) {
      lazy.VentoAuth.promptReauth();
    }
  },

  /**
   * Re-opens the lock window from a place where a synchronous modal call is
   * not allowed (e.g. the lock window's own unload handler).
   */
  lockSoon() {
    Services.tm.dispatchToMainThread(() => this.lock());
  },

  /**
   * Asks the OS to authenticate the user.
   *
   * @returns {Promise<boolean>} true when authentication succeeded. On
   *          platforms without OS reauth (Linux) resolves to true — the lock
   *          is then only a shoulder-surfing barrier, not a security one.
   */
  async requestUnlock() {
    if (!lazy.OSKeyStore.canReauth()) {
      return true;
    }
    try {
      const result = await lazy.OSKeyStore.ensureLoggedIn(
        "unlock Vento",
        "",
        null,
        false
      );
      return !!result.authenticated;
    } catch {
      return false;
    }
  },
};
