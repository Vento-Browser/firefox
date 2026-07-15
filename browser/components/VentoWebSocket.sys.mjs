/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  VentoAuth: "chrome://browser/content/vento/VentoAuth.sys.mjs",
  VentoProxy: "resource:///modules/VentoProxy.sys.mjs",
});

const PREF_ACCESS_TOKEN = "browser.logingate.accessToken";
const PREF_SERVER_URL = "browser.logingate.serverUrl";
const AUTH_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;
const PROXY_CHECK_INTERVAL_MS = 15_000;
const PROXY_CHECK_TIMEOUT_MS = 5_000;
const QUALITY_EXCELLENT_MS = 80;
const QUALITY_GOOD_MS = 250;
const QUALITY_FAIR_MS = 600;

export const VentoWebSocket = {
  _initialized: false,
  _ws: null,
  _authTimer: null,
  _reconnectTimer: null,
  _proxyCheckTimer: null,
  _proxyHost: null,
  _proxyHealthPort: null,
  _status: "disconnected",
  _quality: null,
  _updateGateShown: false,

  get status() {
    return this._status;
  },

  get quality() {
    return this._quality;
  },

  applyBlockingProxy() {
    this._applyBlockingState();
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._applyBlockingState();
    Services.prefs.addObserver(PREF_ACCESS_TOKEN, () => {
      if (!this._ws && this._reconnectTimer === null) {
        this._connect();
      }
    });
    this._connect();
  },

  _applyBlockingState() {
    lazy.VentoProxy.block(this._serverUrl() || undefined);
  },

  _setStatus(status) {
    if (this._status === status) {
      return;
    }
    this._status = status;
    if (status !== "connected") {
      this._setQuality(null);
    }
    Services.obs.notifyObservers(null, "vento-ws-status-changed", status);
  },

  _setQuality(q) {
    if (this._quality === q) {
      return;
    }
    this._quality = q;
    Services.obs.notifyObservers(null, "vento-proxy-quality-changed", q ?? "");
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

    lazy.VentoProxy.allowServer(server);

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
      this._stopProxyCheck();
      this._applyBlockingState();
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

  _startProxyCheck() {
    this._stopProxyCheck();
    this._proxyCheckTimer = lazy.setInterval(
      () => this._checkProxy(),
      PROXY_CHECK_INTERVAL_MS
    );
  },

  _stopProxyCheck() {
    if (this._proxyCheckTimer !== null) {
      lazy.clearInterval(this._proxyCheckTimer);
      this._proxyCheckTimer = null;
    }
  },

  async _checkProxy() {
    if (!this._proxyHost || !this._proxyHealthPort) {
      return;
    }
    const url = `http://${this._proxyHost}:${this._proxyHealthPort}/health`;
    const controller = new AbortController();
    const timeoutId = lazy.setTimeout(
      () => controller.abort(),
      PROXY_CHECK_TIMEOUT_MS
    );
    let ok = false;
    let latencyMs = null;
    try {
      const t0 = Date.now();
      const resp = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
      });
      latencyMs = Date.now() - t0;
      ok = resp.ok;
    } catch {}
    lazy.clearTimeout(timeoutId);

    if (!ok) {
      if (this._status === "connected") {
        this._stopProxyCheck();
        this._applyBlockingState();
        this._setStatus("error");
        this._scheduleReconnect();
      }
      return;
    }

    let quality;
    if (latencyMs < QUALITY_EXCELLENT_MS) {
      quality = "excellent";
    } else if (latencyMs < QUALITY_GOOD_MS) {
      quality = "good";
    } else if (latencyMs < QUALITY_FAIR_MS) {
      quality = "fair";
    } else {
      quality = "poor";
    }
    this._setQuality(quality);
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
        if (this._handleUpdateRequired(msg)) {
          break;
        }
        if (msg.proxy_host && msg.proxy_port) {
          try {
            lazy.VentoProxy.apply(
              msg.proxy_host,
              msg.proxy_port,
              this._serverUrl(),
              this._token()
            );
            this._proxyHost = msg.proxy_host;
            this._proxyHealthPort = msg.proxy_port + 1;
            this._startProxyCheck();
            this._checkProxy();
          } catch (err) {
            console.error("VentoWebSocket: VentoProxy.apply() failed:", err);
          }
        }
        this._setStatus("connected");
        break;
      case "auth_error":
        this._setStatus("error");
        this._stopAuthTimer();
        this._openLoginGate();
        break;
    }
  },

  /**
   * Force update: when the server requires a newer client, keep the proxy in
   * blocking state (only the backend and the download host stay reachable)
   * and show the modal update gate once per session.
   *
   * @param {object} msg - Parsed auth_ok message from the server.
   * @returns {boolean} true when the client is outdated and auth_ok must not
   *          be processed further.
   */
  _handleUpdateRequired(msg) {
    if (!msg.min_client_version) {
      return false;
    }
    let outdated;
    try {
      outdated =
        Services.vc.compare(Services.appinfo.version, msg.min_client_version) <
        0;
    } catch {
      return false;
    }
    if (!outdated) {
      return false;
    }
    this._stopAuthTimer();
    this._setStatus("update_required");
    if (!this._updateGateShown) {
      this._updateGateShown = true;
      const downloadUrl =
        msg.update_download_url || "https://vento-browser.com/download";
      lazy.VentoProxy.allowServer(this._serverUrl(), downloadUrl);
      const params = new URLSearchParams({
        required: msg.min_client_version,
        current: Services.appinfo.version,
        download: downloadUrl,
      });
      Services.ww.openWindow(
        null,
        `chrome://browser/content/updateGate.html?${params}`,
        "_blank",
        "chrome,centerscreen,modal,resizable=no,width=460,height=420",
        null
      );
    }
    return true;
  },

  _openLoginGate() {
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.close();
    }
    this._stopProxyCheck();
    this._applyBlockingState();
    lazy.VentoAuth.promptReauth();
    this._scheduleReconnect();
  },
};
