/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const VentoProxy = {
  /**
   * @param {string} host
   * @param {number} port
   * @param {string} [serverUrl] - Backend URL whose hostname bypasses the proxy.
   * @param {string} [proxyToken] - JWT access token sent as SOCKS5 password.
   */
  apply(host, port, serverUrl, proxyToken) {
    const prefs = Services.prefs;

    prefs.setIntPref("network.proxy.type", 1);
    prefs.setStringPref("network.proxy.socks", host);
    prefs.setIntPref("network.proxy.socks_port", port);
    prefs.setIntPref("network.proxy.socks_version", 5);
    prefs.setBoolPref("network.proxy.socks_remote_dns", true);

    if (proxyToken) {
      prefs.setStringPref("network.proxy.socks_username", "vento");
      prefs.setStringPref("network.proxy.socks_password", proxyToken);
    } else {
      prefs.setStringPref("network.proxy.socks_username", "");
      prefs.setStringPref("network.proxy.socks_password", "");
    }

    const noProxiesParts = [];
    if (serverUrl) {
      try {
        noProxiesParts.push(new URL(serverUrl).hostname);
      } catch {}
    }
    // Allow direct access to the proxy host so health checks bypass SOCKS5.
    if (host) {
      noProxiesParts.push(host);
    }
    prefs.setStringPref(
      "network.proxy.no_proxies_on",
      noProxiesParts.join(",")
    );

    prefs.setBoolPref("network.proxy.failover_direct", false);
    prefs.setBoolPref("network.proxy.allow_hijacking_localhost", true);
    prefs.setBoolPref("media.peerconnection.enabled", false);
    prefs.setBoolPref("network.http.http3.enable", false);
  },

  /**
   * @param {string} serverUrl - Full server URL, e.g. "https://vpn.example.com:3000"
   */
  allowServer(serverUrl) {
    let hostname;
    try {
      hostname = new URL(serverUrl).hostname;
    } catch {
      return;
    }
    if (hostname) {
      Services.prefs.setStringPref("network.proxy.no_proxies_on", hostname);
    }
  },
};
