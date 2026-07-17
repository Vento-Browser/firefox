/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Background Mozilla/Google connections that the audit decided to disable
 * must stay disabled in the shipped defaults.
 * See docs/mozilla-connections-audit.md.
 */

"use strict";

const DISABLED_BOOL_PREFS = [
  "datareporting.healthreport.uploadEnabled",
  "datareporting.policy.dataSubmissionEnabled",
  "toolkit.telemetry.unified",
  "toolkit.telemetry.enabled",
  "toolkit.telemetry.archive.enabled",
  "browser.ping-centre.telemetry",
  "app.normandy.enabled",
  "app.shield.optoutstudies.enabled",
  "messaging-system.rsexperimentloader.enabled",
  "browser.crashReports.unsubmittedCheck.autoSubmit2",
  "network.captive-portal-service.enabled",
  "network.connectivity-service.enabled",
  "browser.topsites.contile.enabled",
  "browser.newtabpage.activity-stream.showSponsored",
  "browser.newtabpage.activity-stream.showSponsoredTopSites",
  "browser.newtabpage.activity-stream.feeds.section.topstories",
  "extensions.pocket.enabled",
  "browser.urlbar.merino.enabled",
  "browser.uitour.enabled",
  "browser.safebrowsing.downloads.remote.enabled",
];

const EMPTY_STRING_PREFS = [
  "app.normandy.api_url",
  "captivedetect.canonicalURL",
];

add_task(async function test_disabled_connections_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  for (const pref of DISABLED_BOOL_PREFS) {
    Assert.equal(
      defaults.getBoolPref(pref),
      false,
      `${pref} must default to false`
    );
  }
  for (const pref of EMPTY_STRING_PREFS) {
    Assert.equal(
      defaults.getStringPref(pref, ""),
      "",
      `${pref} must default to empty`
    );
  }
  Assert.ok(
    !Services.prefs
      .getStringPref("toolkit.telemetry.server")
      .includes("mozilla"),
    "telemetry server must not point at Mozilla"
  );
});
