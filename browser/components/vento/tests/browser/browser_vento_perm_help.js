/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Every rendered permission badge in about:vento carries a "?" help icon
 * that opens a popover with a human-readable description.
 * Requires the live vento-test-env stand (logged-in prefs set by the runner).
 */

"use strict";

add_task(async function test_permission_help_popover() {
  const serverUrl = Services.env.get("VENTO_BACKEND_URL");
  if (!serverUrl) {
    Assert.ok(true, "skipped: vento-test-env stand is not running");
    return;
  }

  await BrowserTestUtils.withNewTab("about:vento", async browser => {
    // about:vento is a chrome page: same-process, direct DOM access.
    const doc = browser.contentDocument;

    // Wait for the page to finish authenticating against the backend
    // (the #full app container is unhidden once authUser is set).
    await TestUtils.waitForCondition(
      () => !doc.getElementById("full").hidden,
      "waiting for about:vento to authenticate"
    );

    // The profile page always renders the current user's permissions
    // (the e2e superuser has all of them).
    const profileLink = doc.querySelector('button.category[name="profile"]');
    Assert.ok(profileLink, "profile nav entry exists");
    profileLink.click();

    await TestUtils.waitForCondition(
      () => doc.querySelector("#profile-perms .perm-help"),
      "waiting for permission help icons on the profile page"
    );

    const help = doc.querySelector("#profile-perms .perm-help");
    Assert.ok(help.title, "help icon has a tooltip description");

    help.click();
    const popover = doc.querySelector(".perm-popover");
    Assert.ok(popover, "clicking the help icon opens the popover");
    Assert.greater(
      popover.querySelector(".perm-popover-text").textContent.length,
      10,
      "popover contains a meaningful description"
    );

    // Popover closes on outside click.
    doc.body.click();
    Assert.ok(
      !doc.querySelector(".perm-popover"),
      "popover closes on outside click"
    );
  });
});
