/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
      Services.ww.openWindow(
        null,
        "chrome://browser/content/loginGate.html",
        "_blank",
        "chrome,centerscreen,modal,resizable=no,width=460,height=560",
        null
      );
    } finally {
      Services.prefs.clearUserPref(PREF_REAUTH);
      this._gateOpen = false;
    }
    const tokenAfter = this.token;
    return !!tokenAfter && tokenAfter !== tokenBefore;
  },
};
