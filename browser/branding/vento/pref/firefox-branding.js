/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file contains branding-specific prefs.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

// Disable automatic updates
pref("app.update.enabled", false);
pref("app.update.auto", false);
pref("app.update.interval", 86400);
pref("app.update.promptWaitTime", 86400);
pref("app.update.badgeWaitTime", 86400);
pref("app.update.url.manual", "");
pref("app.update.url.details", "");
pref("app.releaseNotesURL", "");
pref("app.releaseNotesURL.aboutDialog", "");
pref("app.releaseNotesURL.prompt", "");

// Disable Firefox Accounts and Sync
pref("identity.fxaccounts.enabled", false);
pref("identity.fxaccounts.toolbar.enabled", false);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled", false);
pref("services.sync.engine.addons", false);
pref("services.sync.engine.bookmarks", false);
pref("services.sync.engine.history", false);
pref("services.sync.engine.passwords", false);
pref("services.sync.engine.prefs", false);
pref("services.sync.engine.tabs", false);

// Disable password manager
pref("signon.rememberSignons", false);
pref("signon.autofillForms", false);
pref("signon.generation.enabled", false);
pref("signon.management.page.breach-alerts.enabled", false);

// DevTools console paste enabled
pref("devtools.selfxss.count", 5);

// Proxy hardening — prevent traffic leaks regardless of proxy state.
// These are defaults; proxy host/port are set as user prefs after auth_ok.
pref("network.proxy.type", 1);
pref("network.proxy.failover_direct", false);
pref("network.proxy.socks_remote_dns", true);
pref("network.proxy.allow_hijacking_localhost", true);
pref("media.peerconnection.enabled", false);
pref("media.peerconnection.ice.no_host", true);
pref("media.peerconnection.ice.default_address_only", true);
pref("network.http.http3.enable", false);
