/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Vento secure-autofill tests.
 *
 * Covers the two parent-process halves of the token-based fill pipeline:
 *
 *  - VentoCredentialService: fill tokens are one-shot, expire after their
 *    TTL, and only resolve for the origin the credential is bound to.
 *  - VentoNetworkObserver: an outgoing HTTP request body containing a fill
 *    token (raw or percent-encoded) reaches the server with the real
 *    password substituted in — but only when the request goes to the bound
 *    origin. Any other destination receives the useless token string.
 */

"use strict";

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { VentoCredentialService, TOKEN_PREFIX } = ChromeUtils.importESModule(
  "chrome://browser/content/vento/VentoCredentialService.sys.mjs"
);
const { VentoNetworkObserver } = ChromeUtils.importESModule(
  "resource:///modules/VentoNetworkObserver.sys.mjs"
);

const PASSWORD = "s3cr€t!&=";

function postChannel(url, body, contentType) {
  const channel = NetUtil.newChannel({
    uri: url,
    loadUsingSystemPrincipal: true,
  });
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream
  );
  stream.setByteStringData(body);
  channel
    .QueryInterface(Ci.nsIUploadChannel2)
    .explicitSetUploadStream(stream, contentType, -1, "POST", false);
  return channel;
}

function openChannel(channel) {
  return new Promise((resolve, reject) => {
    channel.asyncOpen({
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIRequestObserver",
      ]),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        NetUtil.readInputStreamToString(stream, count);
      },
      onStopRequest(request, status) {
        if (Components.isSuccessCode(status)) {
          resolve();
        } else {
          reject(new Error(`channel failed: 0x${status.toString(16)}`));
        }
      },
    });
  });
}

let gServer;
let gOrigin;
let gLastBody = null;

add_setup(function () {
  // The Vento branding prefs lock localhost hijacking on so that even
  // loopback traffic goes through the SOCKS proxy. No proxy exists in the
  // test environment and failover_direct is locked off, so requests to the
  // local test server would hang forever. Unlock and let localhost go DIRECT.
  Services.prefs.unlockPref("network.proxy.allow_hijacking_localhost");
  Services.prefs
    .getDefaultBranch("")
    .setBoolPref("network.proxy.allow_hijacking_localhost", false);

  gServer = new HttpServer();
  gServer.registerPathHandler("/login", (request, response) => {
    gLastBody = NetUtil.readInputStreamToString(
      request.bodyInputStream,
      request.bodyInputStream.available()
    );
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.write("ok");
  });
  gServer.start(-1);
  gOrigin = `http://localhost:${gServer.identity.primaryPort}`;

  VentoCredentialService.init();
  VentoNetworkObserver.init();

  registerCleanupFunction(async () => {
    VentoNetworkObserver.terminate();
    VentoCredentialService.terminate();
    await new Promise(resolve => gServer.stop(resolve));
  });
});

add_task(function test_token_format() {
  const token = VentoCredentialService.issueToken(PASSWORD, gOrigin, 1);
  Assert.ok(token.startsWith(TOKEN_PREFIX), "token has the VENTO_CRED prefix");
  Assert.equal(token.length, TOKEN_PREFIX.length + 36, "token carries a UUID");
  Assert.notEqual(
    token,
    VentoCredentialService.issueToken(PASSWORD, gOrigin, 1),
    "every token is unique"
  );
  VentoCredentialService.revokeContext(1);
});

add_task(function test_token_one_shot_and_origin_bound() {
  const token = VentoCredentialService.issueToken(PASSWORD, gOrigin, 2);

  Assert.equal(
    VentoCredentialService.resolve(token, "https://attacker.example"),
    null,
    "resolve refuses a foreign origin"
  );
  Assert.equal(
    VentoCredentialService.resolve(token, gOrigin),
    PASSWORD,
    "resolve returns the plaintext for the bound origin"
  );
  Assert.equal(
    VentoCredentialService.resolve(token, gOrigin),
    null,
    "a token is one-shot"
  );
});

add_task(function test_token_expiry() {
  const token = VentoCredentialService.issueToken(PASSWORD, gOrigin, 3);
  VentoCredentialService._tokens.get(token).expiry = Date.now() - 1;
  Assert.equal(
    VentoCredentialService.resolve(token, gOrigin),
    null,
    "an expired token does not resolve"
  );
});

add_task(function test_revoke_context() {
  const token = VentoCredentialService.issueToken(PASSWORD, gOrigin, 42);
  VentoCredentialService.revokeContext(42);
  Assert.equal(
    VentoCredentialService.resolve(token, gOrigin),
    null,
    "revokeContext drops the token"
  );
});

add_task(async function test_substitution_urlencoded_body() {
  const token = VentoCredentialService.issueToken(PASSWORD, gOrigin, 0);
  const encodedToken = token.replace(":", "%3A");

  gLastBody = null;
  await openChannel(
    postChannel(
      `${gOrigin}/login`,
      `username=alice&password=${encodedToken}`,
      "application/x-www-form-urlencoded"
    )
  );

  Assert.ok(
    !gLastBody.includes("VENTO_CRED"),
    "no token reaches the server in a form-urlencoded body"
  );
  Assert.equal(
    gLastBody,
    `username=alice&password=${encodeURIComponent(PASSWORD)}`,
    "the server receives the percent-encoded real password"
  );
});

add_task(async function test_substitution_raw_body() {
  const token = VentoCredentialService.issueToken(PASSWORD, gOrigin, 0);

  gLastBody = null;
  await openChannel(
    postChannel(
      `${gOrigin}/login`,
      JSON.stringify({ username: "alice", password: token }),
      "application/json"
    )
  );

  Assert.ok(
    !gLastBody.includes("VENTO_CRED"),
    "no token reaches the server in a JSON body"
  );
  const utf8Password = String.fromCharCode(
    ...new TextEncoder().encode(PASSWORD)
  );
  Assert.equal(
    gLastBody,
    `{"username":"alice","password":"${utf8Password}"}`,
    "the server receives the UTF-8 real password bytes"
  );
});

add_task(async function test_no_substitution_for_foreign_origin() {
  const token = VentoCredentialService.issueToken(
    PASSWORD,
    "https://bank.example",
    0
  );

  gLastBody = null;
  await openChannel(
    postChannel(
      `${gOrigin}/login`,
      `stolen=${token.replace(":", "%3A")}`,
      "application/x-www-form-urlencoded"
    )
  );

  Assert.ok(
    gLastBody.includes("VENTO_CRED%3A"),
    "a foreign-origin request carries the token, not the password"
  );
  Assert.ok(
    !gLastBody.includes(encodeURIComponent(PASSWORD)),
    "the password never leaks to a foreign origin"
  );
  Assert.equal(
    VentoCredentialService.resolve(token, "https://bank.example"),
    PASSWORD,
    "a refused resolve does not consume the token"
  );
});
