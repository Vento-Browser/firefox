/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file contains branding-specific prefs.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

// Application update endpoints (the update-check URL itself is baked into
// application.ini via MOZ_APPUPDATE_HOST; these are the user-facing pages).
pref("app.update.url.manual", "https://vento-browser.com/download");
pref("app.update.url.details", "https://vento-browser.com/download");
pref("app.releaseNotesURL", "https://vento-browser.com/releases");
pref("app.releaseNotesURL.aboutDialog", "https://vento-browser.com/releases");
pref("app.releaseNotesURL.prompt", "https://vento-browser.com/releases");
// User-facing documentation and feedback links (default: support.mozilla.org
// and ideas.mozilla.org). about:preferences learn-more links resolve against
// app.support.baseURL.
pref("app.support.baseURL", "https://vento-browser.com/support/");
pref("app.feedback.baseURL", "https://vento-browser.com/feedback");

// Disable Firefox Accounts and Sync
pref("identity.fxaccounts.enabled", false);
pref("browser.aboutwelcome.enabled", false);
pref("browser.preferences.moreFromMozilla", false);

// Disable Mozilla product promos (VPN/Focus/pin) in private browsing and elsewhere
pref("browser.vpn_promo.enabled", false);
pref("browser.promo.focus.enabled", false);
pref("browser.promo.pin.enabled", false);
pref("identity.fxaccounts.toolbar.enabled", false);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled", false);
// Default sidebar launcher tools: no Mozilla syncedtabs (needs an FxA
// account) and no Mozilla AI chatbot.
pref("sidebar.main.tools", "history,bookmarks");
pref("services.sync.engine.addons", false);
pref("services.sync.engine.bookmarks", false);
pref("services.sync.engine.history", false);
pref("services.sync.engine.passwords", false);
pref("services.sync.engine.prefs", false);
pref("services.sync.engine.tabs", false);

// Disable password manager
pref("signon.firefoxRelay.feature", "disabled");
pref("signon.rememberSignons", false);
pref("signon.autofillForms", false);
pref("signon.generation.enabled", false);
pref("signon.management.page.breach-alerts.enabled", false);

// DevTools console paste enabled
pref("devtools.selfxss.count", 5);

// Proxy hardening — prevent traffic leaks regardless of proxy state.
// Locked so users cannot override via about:config or user.js.
// VentoProxy/VentoWebSocket unlock these at runtime before updating, then re-lock.
// NOTE: default pref files only support pref(name, value, locked) — the
// autoconfig-style lockPref() keyword is a silent parse error here.
pref("network.proxy.type", 1, locked);
pref("network.proxy.failover_direct", false, locked);
pref("network.proxy.socks_remote_dns", true, locked);
pref("network.proxy.allow_hijacking_localhost", true, locked);
pref("media.peerconnection.enabled", false, locked);
pref("media.peerconnection.ice.no_host", true, locked);
pref("media.peerconnection.ice.default_address_only", true, locked);
pref("network.http.http3.enable", false, locked);
