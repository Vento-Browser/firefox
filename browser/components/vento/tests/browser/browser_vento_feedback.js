/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The "Send feedback" button in about:vento opens the feedback page
 * (app.feedback.baseURL) with a source parameter in a new tab.
 */

"use strict";

add_task(async function test_feedback_button_opens_tab() {
  const serverUrl = Services.env.get("VENTO_BACKEND_URL");
  if (!serverUrl) {
    Assert.ok(true, "skipped: vento-test-env stand is not running");
    return;
  }

  // Keep the test hermetic: point the feedback base at the local server.
  const localBase =
    "http://mochi.test:8888/browser/browser/components/vento/tests/browser/feedback_page.html";
  await SpecialPowers.pushPrefEnv({
    set: [["app.feedback.baseURL", localBase]],
  });

  await BrowserTestUtils.withNewTab("about:vento", async browser => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => !doc.getElementById("full").hidden,
      "waiting for about:vento to authenticate"
    );

    const btn = doc.getElementById("btn-feedback");
    Assert.ok(btn, "feedback button exists in the nav");

    const tabPromise = BrowserTestUtils.waitForNewTab(gBrowser, url =>
      url.includes("source=vento-panel")
    );
    btn.click();
    const tab = await tabPromise;
    const openedUrl = tab.linkedBrowser.currentURI.spec;
    Assert.ok(
      openedUrl.startsWith(localBase) &&
        openedUrl.includes("source=vento-panel"),
      `feedback tab must open the feedback base URL with a source (got ${openedUrl})`
    );
    BrowserTestUtils.removeTab(tab);
  });
});
