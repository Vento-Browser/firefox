/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_ACCESS_TOKEN = "browser.logingate.accessToken";
const PREF_SERVER_URL = "browser.logingate.serverUrl";
const AUTH_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;

export const VentoWebSocket = {
  _initialized: false,
  _ws: null,
  _authTimer: null,
  _reconnectTimer: null,
  _status: "disconnected",

  get status() {
    return this._status;
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._connect();
  },

  _setStatus(status) {
    if (this._status === status) {
      return;
    }
    this._status = status;
    Services.obs.notifyObservers(null, "vento-ws-status-changed", status);
  },

  _serverUrl() {
    return Services.prefs.getStringPref(PREF_SERVER_URL, "");
  },

  _token() {
    return Services.prefs.getStringPref(PREF_ACCESS_TOKEN, "");
  },

  _connect() {
    const server = this._serverUrl();
    const token = this._token();
    if (!server || !token) {
      this._setStatus("disconnected");
      return;
    }

    const wsUrl = server.replace(/^http/, "ws") + "/ws";
    this._setStatus("connecting");

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      this._setStatus("error");
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener("open", () => {
      if (this._ws !== ws) {
        return;
      }
      this._sendAuth();
      this._startAuthTimer();
    });

    ws.addEventListener("message", ev => {
      if (this._ws !== ws) {
        return;
      }
      this._onMessage(ev.data);
    });

    ws.addEventListener("close", () => {
      if (this._ws !== ws) {
        return;
      }
      this._ws = null;
      this._stopAuthTimer();
      this._setStatus("disconnected");
      this._scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (this._ws !== ws) {
        return;
      }
      this._setStatus("error");
    });
  },

  _sendAuth() {
    const token = this._token();
    if (!token || this._ws?.readyState !== 1 /* OPEN */) {
      return;
    }
    this._ws.send(JSON.stringify({ type: "auth", token }));
  },

  _startAuthTimer() {
    this._stopAuthTimer();
    this._authTimer = lazy.setInterval(
      () => this._sendAuth(),
      AUTH_INTERVAL_MS
    );
  },

  _stopAuthTimer() {
    if (this._authTimer !== null) {
      lazy.clearInterval(this._authTimer);
      this._authTimer = null;
    }
  },

  _scheduleReconnect() {
    if (this._reconnectTimer !== null) {
      return;
    }
    this._reconnectTimer = lazy.setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
  },

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "auth_ok":
        this._setStatus("connected");
        break;
      case "auth_error":
        this._setStatus("error");
        this._stopAuthTimer();
        this._openLoginGate();
        break;
    }
  },

  _openLoginGate() {
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.close();
    }
    Services.prefs.setBoolPref("browser.logingate.reauth", true);
    Services.ww.openWindow(
      null,
      "chrome://browser/content/loginGate.html",
      "_blank",
      "chrome,centerscreen,modal,resizable=no,width=460,height=560",
      null
    );
    Services.prefs.clearUserPref("browser.logingate.reauth");
    this._scheduleReconnect();
  },
};
