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
    const lock = (name, setter, value) => {
      prefs.unlockPref(name);
      prefs[setter](name, value);
      prefs.lockPref(name);
    };

    lock("network.proxy.type", "setIntPref", 1);
    lock("network.proxy.socks", "setStringPref", host);
    lock("network.proxy.socks_port", "setIntPref", port);
    lock("network.proxy.socks_version", "setIntPref", 5);
    lock("network.proxy.socks_remote_dns", "setBoolPref", true);

    if (proxyToken) {
      lock("network.proxy.socks_username", "setStringPref", "vento");
      lock("network.proxy.socks_password", "setStringPref", proxyToken);
    } else {
      lock("network.proxy.socks_username", "setStringPref", "");
      lock("network.proxy.socks_password", "setStringPref", "");
    }

    const noProxiesParts = ["localhost", "127.0.0.1", "::1"];
    if (serverUrl) {
      try {
        const h = new URL(serverUrl).hostname;
        if (!noProxiesParts.includes(h)) {
          noProxiesParts.push(h);
        }
      } catch {}
    }
    lock("network.proxy.no_proxies_on", "setStringPref", noProxiesParts.join(","));

    lock("network.proxy.failover_direct", "setBoolPref", false);
    lock("network.proxy.allow_hijacking_localhost", "setBoolPref", true);
    lock("media.peerconnection.enabled", "setBoolPref", false);
    lock("network.http.http3.enable", "setBoolPref", false);
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
      const parts = ["localhost", "127.0.0.1", "::1"];
      if (!parts.includes(hostname)) {
        parts.push(hostname);
      }
      const prefs = Services.prefs;
      prefs.unlockPref("network.proxy.no_proxies_on");
      prefs.setStringPref("network.proxy.no_proxies_on", parts.join(","));
      prefs.lockPref("network.proxy.no_proxies_on");
    }
  },
};
