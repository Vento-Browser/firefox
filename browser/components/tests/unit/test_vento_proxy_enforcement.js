/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento proxy-enforcement tests.
 *
 * These assert *effective* pref values (what nsProtocolProxyService actually
 * reads) rather than what was written. A locked pref reads back its
 * default-branch value, so writing the user branch and locking silently
 * disables the proxy — the exact regression these tests exist to catch.
 * They also drive nsIProtocolProxyService.asyncResolve to prove that real
 * channels resolve to the SOCKS5 proxy and that only localhost and the
 * backend host resolve to DIRECT.
 */

"use strict";

const { VentoProxy } = ChromeUtils.importESModule(
  "resource:///modules/VentoProxy.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const PROXY_HOST = "proxy.vento.test";
const PROXY_PORT = 41080;
const BACKEND_URL = "https://backend.vento.test:3000";
const TOKEN = "test-jwt-token-123";

const gPPS = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
  Ci.nsIProtocolProxyService
);

function resolveProxy(spec) {
  return new Promise((resolve, reject) => {
    const channel = NetUtil.newChannel({
      uri: spec,
      loadUsingSystemPrincipal: true,
    });
    gPPS.asyncResolve(channel, 0, {
      onProxyAvailable(_req, _chan, proxyInfo, status) {
        if (!Components.isSuccessCode(status)) {
          reject(new Error(`asyncResolve failed: ${status}`));
          return;
        }
        resolve(proxyInfo);
      },
    });
  });
}

function assertEffectiveAndLocked(name, getter, expected) {
  Assert.ok(Services.prefs.prefIsLocked(name), `${name} must be locked`);
  Assert.equal(
    Services.prefs[getter](name),
    expected,
    `${name} effective value`
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue(name),
    `${name} must not carry a stale user-branch value`
  );
}

function assertHardeningPrefs() {
  assertEffectiveAndLocked("network.proxy.socks_version", "getIntPref", 5);
  assertEffectiveAndLocked(
    "network.proxy.socks_remote_dns",
    "getBoolPref",
    true
  );
  assertEffectiveAndLocked(
    "network.proxy.failover_direct",
    "getBoolPref",
    false
  );
  assertEffectiveAndLocked("network.proxy.allow_bypass", "getBoolPref", false);
  assertEffectiveAndLocked(
    "media.peerconnection.enabled",
    "getBoolPref",
    false
  );
  assertEffectiveAndLocked("network.http.http3.enable", "getBoolPref", false);
  assertEffectiveAndLocked("network.trr.mode", "getIntPref", 5);
  assertEffectiveAndLocked("network.dns.disablePrefetch", "getBoolPref", true);
  assertEffectiveAndLocked(
    "network.connectivity-service.enabled",
    "getBoolPref",
    false
  );
  assertEffectiveAndLocked(
    "network.captive-portal-service.enabled",
    "getBoolPref",
    false
  );
}

add_task(async function test_blocking_state_effective() {
  VentoProxy.block(BACKEND_URL);

  assertEffectiveAndLocked("network.proxy.type", "getIntPref", 1);
  assertEffectiveAndLocked("network.proxy.socks", "getStringPref", "127.0.0.1");
  assertEffectiveAndLocked("network.proxy.socks_port", "getIntPref", 1);
  assertHardeningPrefs();

  const noProxies = Services.prefs.getStringPref("network.proxy.no_proxies_on");
  Assert.ok(
    noProxies.includes("backend.vento.test"),
    `backend host exempted in blocking state (${noProxies})`
  );

  const pi = await resolveProxy("https://example.com/");
  Assert.notEqual(pi, null, "blocking state still proxies external hosts");
  Assert.equal(pi.host, "127.0.0.1", "blocking proxy host");
  Assert.equal(pi.port, 1, "blocking proxy port (dead endpoint)");
});

add_task(async function test_apply_effective_values() {
  VentoProxy.apply(PROXY_HOST, PROXY_PORT, BACKEND_URL, TOKEN);

  assertEffectiveAndLocked("network.proxy.type", "getIntPref", 1);
  assertEffectiveAndLocked("network.proxy.socks", "getStringPref", PROXY_HOST);
  assertEffectiveAndLocked(
    "network.proxy.socks_port",
    "getIntPref",
    PROXY_PORT
  );
  assertEffectiveAndLocked(
    "network.proxy.socks_username",
    "getStringPref",
    "vento"
  );
  assertEffectiveAndLocked(
    "network.proxy.socks_password",
    "getStringPref",
    TOKEN
  );
  assertHardeningPrefs();

  const noProxies = Services.prefs.getStringPref("network.proxy.no_proxies_on");
  for (const expected of [
    "localhost",
    "127.0.0.1",
    "::1",
    "backend.vento.test",
  ]) {
    Assert.ok(
      noProxies.split(",").includes(expected),
      `no_proxies_on contains ${expected} (${noProxies})`
    );
  }
});

add_task(async function test_external_hosts_resolve_to_socks5() {
  for (const url of [
    "https://example.com/",
    "http://example.org/page",
    "https://sub.deep.example.net:8443/x",
  ]) {
    const pi = await resolveProxy(url);
    Assert.notEqual(pi, null, `${url} must not resolve to DIRECT`);
    Assert.equal(pi.type, "socks", `${url} uses SOCKS5`);
    Assert.equal(pi.host, PROXY_HOST, `${url} proxy host`);
    Assert.equal(pi.port, PROXY_PORT, `${url} proxy port`);
    Assert.equal(pi.username, "vento", `${url} SOCKS username`);
    Assert.equal(pi.password, TOKEN, `${url} SOCKS password is the JWT`);
    Assert.ok(
      pi.flags & Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
      `${url} DNS is resolved by the proxy (no local DNS leak)`
    );
    Assert.equal(
      pi.failoverProxy,
      null,
      `${url} has no DIRECT failover (failover_direct locked off)`
    );
  }
});

add_task(async function test_backend_and_localhost_resolve_direct() {
  for (const url of [
    `${BACKEND_URL}/api/auth/validate`,
    "http://localhost:1081/health",
    "http://127.0.0.1:3000/ws",
  ]) {
    const pi = await resolveProxy(url);
    Assert.equal(pi, null, `${url} must resolve to DIRECT`);
  }
});

add_task(async function test_prefs_resist_user_branch_writes() {
  // Writes to locked prefs are silently ignored (Pref::SetValue guards on
  // IsLocked); the enforced value must survive and no user value may stick.
  try {
    Services.prefs.setIntPref("network.proxy.type", 0);
  } catch {}
  try {
    Services.prefs.setStringPref("network.proxy.socks", "evil.test");
  } catch {}

  Assert.equal(
    Services.prefs.getIntPref("network.proxy.type"),
    1,
    "network.proxy.type survives a user-branch write attempt"
  );
  Assert.equal(
    Services.prefs.getStringPref("network.proxy.socks"),
    PROXY_HOST,
    "network.proxy.socks survives a user-branch write attempt"
  );
  const pi = await resolveProxy("https://example.com/");
  Assert.equal(pi.host, PROXY_HOST, "resolution still uses the real proxy");

  // A write to a locked pref is masked but still stored on the user branch;
  // it would take effect if the pref were ever unlocked. Re-applying must
  // scrub it.
  VentoProxy.apply(PROXY_HOST, PROXY_PORT, BACKEND_URL, TOKEN);
  Assert.ok(
    !Services.prefs.prefHasUserValue("network.proxy.type"),
    "re-apply scrubs masked user-branch writes (type)"
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue("network.proxy.socks"),
    "re-apply scrubs masked user-branch writes (socks)"
  );
});

add_task(async function test_block_after_apply_cycle() {
  VentoProxy.block(BACKEND_URL);

  Assert.equal(
    Services.prefs.getStringPref("network.proxy.socks"),
    "127.0.0.1"
  );
  Assert.equal(Services.prefs.getIntPref("network.proxy.socks_port"), 1);

  const pi = await resolveProxy("https://example.com/");
  Assert.notEqual(pi, null, "traffic is blocked again after disconnect");
  Assert.equal(pi.port, 1, "dead endpoint restored");

  VentoProxy.apply(PROXY_HOST, PROXY_PORT, BACKEND_URL, TOKEN);
  const pi2 = await resolveProxy("https://example.com/");
  Assert.equal(pi2.host, PROXY_HOST, "re-apply after block works");
});

add_task(async function test_allow_server_updates_exemptions() {
  VentoProxy.allowServer("https://other-backend.vento.test:8443");
  const noProxies = Services.prefs.getStringPref("network.proxy.no_proxies_on");
  Assert.ok(
    noProxies.includes("other-backend.vento.test"),
    "allowServer exempts the new backend host"
  );
  Assert.ok(
    Services.prefs.prefIsLocked("network.proxy.no_proxies_on"),
    "no_proxies_on stays locked after allowServer"
  );

  const pi = await resolveProxy("https://other-backend.vento.test:8443/ws");
  Assert.equal(pi, null, "new backend resolves DIRECT");
});
