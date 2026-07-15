/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Writes the value on the default branch before locking: a locked pref
 * always reads back its default-branch value (see Preferences.cpp,
 * Pref::GetValue), so writing the user branch and locking would make the
 * enforced value invisible to nsProtocolProxyService.
 *
 * @param {string} name
 * @param {string} setter - nsIPrefBranch setter method name.
 * @param {string|number|boolean} value
 */
function setLockedPref(name, setter, value) {
  const prefs = Services.prefs;
  if (prefs.prefIsLocked(name)) {
    prefs.unlockPref(name);
  }
  if (prefs.prefHasUserValue(name)) {
    prefs.clearUserPref(name);
  }
  prefs.getDefaultBranch("")[setter](name, value);
  prefs.lockPref(name);
}

function noProxiesValue(...serverUrls) {
  const parts = ["localhost", "127.0.0.1", "::1"];
  for (const serverUrl of serverUrls) {
    if (!serverUrl) {
      continue;
    }
    try {
      const h = new URL(serverUrl).hostname;
      if (h && !parts.includes(h)) {
        parts.push(h);
      }
    } catch {}
  }
  return parts.join(",");
}

// Locked whenever the proxy is configured (real or blocking). Closes the
// known bypass vectors: extension proxy bypass, native DNS from the
// connectivity service / captive portal detector / TRR heuristics, DNS
// prefetch, WebRTC ICE and HTTP/3 (UDP paths that skip the SOCKS tunnel).
const HARDENING_PREFS = [
  ["network.proxy.socks_version", "setIntPref", 5],
  ["network.proxy.socks_remote_dns", "setBoolPref", true],
  ["network.proxy.failover_direct", "setBoolPref", false],
  ["network.proxy.allow_bypass", "setBoolPref", false],
  ["media.peerconnection.enabled", "setBoolPref", false],
  ["network.http.http3.enable", "setBoolPref", false],
  ["network.trr.mode", "setIntPref", 5],
  ["network.dns.disablePrefetch", "setBoolPref", true],
  ["network.connectivity-service.enabled", "setBoolPref", false],
  ["network.captive-portal-service.enabled", "setBoolPref", false],
];

export const VentoProxy = {
  /**
   * @param {string} host
   * @param {number} port
   * @param {string} [serverUrl] - Backend URL whose hostname bypasses the proxy.
   * @param {string} [proxyToken] - JWT access token sent as SOCKS5 password.
   */
  apply(host, port, serverUrl, proxyToken) {
    setLockedPref("network.proxy.type", "setIntPref", 1);
    setLockedPref("network.proxy.socks", "setStringPref", host);
    setLockedPref("network.proxy.socks_port", "setIntPref", port);

    if (proxyToken) {
      setLockedPref("network.proxy.socks_username", "setStringPref", "vento");
      setLockedPref(
        "network.proxy.socks_password",
        "setStringPref",
        proxyToken
      );
    } else {
      setLockedPref("network.proxy.socks_username", "setStringPref", "");
      setLockedPref("network.proxy.socks_password", "setStringPref", "");
    }

    setLockedPref(
      "network.proxy.no_proxies_on",
      "setStringPref",
      noProxiesValue(serverUrl)
    );
    setLockedPref(
      "network.proxy.allow_hijacking_localhost",
      "setBoolPref",
      true
    );
    this._applyHardening();
  },

  /**
   * Blocking state: route everything into a dead SOCKS endpoint so no
   * traffic can leave until a real proxy is applied. Only localhost and
   * the backend host (if known) stay reachable.
   *
   * @param {string} [serverUrl]
   */
  block(serverUrl) {
    setLockedPref("network.proxy.type", "setIntPref", 1);
    setLockedPref("network.proxy.socks", "setStringPref", "127.0.0.1");
    setLockedPref("network.proxy.socks_port", "setIntPref", 1);
    setLockedPref(
      "network.proxy.no_proxies_on",
      "setStringPref",
      noProxiesValue(serverUrl)
    );
    this._applyHardening();
  },

  /**
   * Hosts of the given URLs bypass the proxy (replaces the previous list).
   *
   * @param {...string} serverUrls - Full URLs, e.g. "https://vpn.example.com:3000"
   */
  allowServer(...serverUrls) {
    setLockedPref(
      "network.proxy.no_proxies_on",
      "setStringPref",
      noProxiesValue(...serverUrls)
    );
  },

  _applyHardening() {
    for (const [name, setter, value] of HARDENING_PREFS) {
      setLockedPref(name, setter, value);
    }
  },
};
