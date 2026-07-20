/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

// Seconds of user inactivity before the browser locks; 0 disables idle lock.
const PREF_IDLE_SECONDS = "browser.vento.lock.idleSeconds";
const DEFAULT_IDLE_SECONDS = 600;

// Notified (data = "locked" | "unlocked") whenever the lock state changes.
// Each browser window observes this to show/hide its in-window lock overlay.
const TOPIC_LOCK_CHANGED = "vento-lock-changed";

/**
 * Locks the browser UI after a period of inactivity (or on demand). Rather
 * than an app-modal window that could be closed to reveal the tabs behind it,
 * every browser window paints a full-window lock overlay (gVentoLockOverlay in
 * browser-init.js) that captures input until the user unlocks. Unlocking
 * requires OS-level authentication (Touch ID / Windows Hello / account
 * password) via OSKeyStore.
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
   * Locks the browser. Shows the lock overlay in every open browser window;
   * windows opened while locked paint it on startup. Returns immediately.
   */
  lock() {
    if (this._locked) {
      return;
    }
    this._locked = true;
    Services.obs.notifyObservers(null, TOPIC_LOCK_CHANGED, "locked");
  },

  /**
   * Unlocks the browser, hiding the overlay in every window. Callers must have
   * authenticated the user first (see requestUnlock).
   */
  unlock() {
    if (!this._locked) {
      return;
    }
    this._locked = false;
    Services.obs.notifyObservers(null, TOPIC_LOCK_CHANGED, "unlocked");
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
