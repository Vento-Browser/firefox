/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  VentoSessionVault: "chrome://browser/content/vento/VentoSessionVault.sys.mjs",
});

const PREF_ACCESS_TOKEN = "browser.logingate.accessToken";
const PREF_REAUTH = "browser.logingate.reauth";

/**
 * Single entry point for re-authentication. Any Vento component that gets a
 * 401 from the backend calls promptReauth() instead of opening the login gate
 * itself, so concurrent failures produce a single modal window.
 */
export const VentoAuth = {
  _gateOpen: false,

  get token() {
    return Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "");
  },

  /**
   * Hides every open browser window for the lifetime of fn, then restores
   * only the windows this call hid. Used around the modal lock/login gates
   * so tab contents are never visible behind them.
   *
   * @param {Function} fn - Synchronous function (typically a modal
   *        openWindow call that spins a nested event loop).
   * @returns {*} fn's return value.
   */
  withBrowserWindowsHidden(fn) {
    const hidden = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      try {
        // Blank the window contents (CSS rule on vento-obscured in
        // browser.css) and hide the window at the widget level.
        win.document.documentElement.setAttribute("vento-obscured", "true");
        hidden.push(Cu.getWeakReference(win));
        win.docShell.treeOwner
          .QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIBaseWindow).visibility = false;
      } catch {}
    }
    try {
      return fn();
    } finally {
      for (const ref of hidden) {
        try {
          const win = ref.get();
          if (win && !win.closed) {
            win.document.documentElement.removeAttribute("vento-obscured");
            win.docShell.treeOwner
              .QueryInterface(Ci.nsIInterfaceRequestor)
              .getInterface(Ci.nsIBaseWindow).visibility = true;
          }
        } catch {}
      }
    }
  },

  /**
   * Opens the modal login gate and blocks until it closes. The reauth pref
   * tells the gate's unload handler not to quit the browser on cancel.
   *
   * @returns {boolean} true if the user completed a login (a new access
   *          token was written), false on cancel or when a gate is already
   *          open.
   */
  promptReauth() {
    if (this._gateOpen) {
      return false;
    }
    this._gateOpen = true;
    const tokenBefore = this.token;
    Services.prefs.setBoolPref(PREF_REAUTH, true);
    try {
      // The login ("Connect") window must never show tab contents behind it.
      this.withBrowserWindowsHidden(() =>
        Services.ww.openWindow(
          null,
          "chrome://browser/content/loginGate.html",
          "_blank",
          "chrome,centerscreen,modal,resizable=no,width=460,height=640",
          null
        )
      );
    } finally {
      Services.prefs.clearUserPref(PREF_REAUTH);
      this._gateOpen = false;
    }
    const tokenAfter = this.token;
    return !!tokenAfter && tokenAfter !== tokenBefore;
  },

  /**
   * Full logout: seals the browsing state into the encrypted vault (while the
   * token is still valid), clears the token, wipes all browsing data, and —
   * unless promptLogin is false — shows the login gate. If the user does not
   * log back in, the browser quits: a logged-out browser has nothing to show.
   *
   * @param {object} [options]
   * @param {boolean} [options.promptLogin=true] false when the caller manages
   *        the login UI itself (lock window, login gate).
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
    const loggedIn = this.promptReauth();
    if (!loggedIn) {
      Services.startup.quit(Services.startup.eAttemptQuit);
    }
    return loggedIn;
  },
};
