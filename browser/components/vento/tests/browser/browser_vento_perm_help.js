/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Every rendered permission badge in about:vento is itself clickable and
 * opens a popover with a human-readable description.
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
    const profileLink = doc.querySelector('moz-page-nav-button[view="profile"]');
    Assert.ok(profileLink, "profile nav entry exists");
    profileLink.activate();

    await TestUtils.waitForCondition(
      () => doc.querySelector("#profile-perms .perm-badge-clickable"),
      "waiting for permission badges on the profile page"
    );

    const badge = doc.querySelector("#profile-perms .perm-badge-clickable");
    Assert.ok(badge.title, "permission badge has a tooltip description");
    Assert.ok(
      !doc.querySelector("#profile-perms .perm-help"),
      "no separate help button next to badges (chip itself is the trigger)"
    );

    badge.click();
    const popover = doc.querySelector(".perm-popover");
    Assert.ok(popover, "clicking the permission badge opens the popover");
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

/**
 * The "?" affordance inside the permission-editing checkbox grid must open the
 * popover without toggling the checkbox: the icon sits inside the checkbox
 * <label>, so an unprevented click would be forwarded to the checkbox and the
 * forwarded click would instantly close the popover again.
 */
add_task(async function test_permission_help_in_checkbox_grid() {
  const serverUrl = Services.env.get("VENTO_BACKEND_URL");
  const accessToken = Services.env.get("VENTO_ACCESS_TOKEN");
  if (!serverUrl || !accessToken) {
    Assert.ok(true, "skipped: vento-test-env stand is not running");
    return;
  }

  // The grid only renders when editing someone else's permissions (the
  // superuser's own row has no Edit button), so create a fixture user.
  // Inactive so it doesn't consume a license seat.
  const email = `perm-grid-${Date.now()}@vento.test`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const createRes = await fetch(`${serverUrl}/api/auth/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      display_name: "Perm Grid Fixture",
      password: "PermGridFixture48!",
      is_active: false,
    }),
  });
  Assert.ok(createRes.ok, "fixture user created");
  const fixture = await createRes.json();
  registerCleanupFunction(async () => {
    await fetch(`${serverUrl}/api/auth/users/${fixture.id}`, {
      method: "DELETE",
      headers,
    }).catch(() => {});
  });

  await BrowserTestUtils.withNewTab("about:vento", async browser => {
    const doc = browser.contentDocument;
    const win = browser.contentWindow;

    await TestUtils.waitForCondition(
      () => !doc.getElementById("full").hidden,
      "waiting for about:vento to authenticate"
    );

    doc.getElementById("nav-users").activate();
    await TestUtils.waitForCondition(
      () =>
        [...doc.querySelectorAll("tbody tr")].some(tr =>
          tr.textContent.includes(email)
        ),
      "waiting for the fixture user row"
    );

    const row = [...doc.querySelectorAll("tbody tr")].find(tr =>
      tr.textContent.includes(email)
    );
    const editBtn = [...row.querySelectorAll("moz-button")].find(
      b => b.textContent.trim() === "Edit"
    );
    Assert.ok(editBtn, "fixture user row has an Edit button");
    editBtn.click();

    await TestUtils.waitForCondition(
      () => doc.querySelector(".perm-check-label .perm-help"),
      "waiting for the permission checkbox grid"
    );

    const label = doc.querySelector(".perm-check-label");
    const checkbox = label.querySelector("input[type=checkbox]");
    const help = label.querySelector(".perm-help");
    const checkedBefore = checkbox.checked;

    help.scrollIntoView();
    EventUtils.synthesizeMouseAtCenter(help, {}, win);

    const popover = doc.querySelector(".perm-popover");
    Assert.ok(popover, "clicking the grid ? opens the popover (and it stays)");
    Assert.greater(
      popover.querySelector(".perm-popover-text").textContent.length,
      10,
      "popover contains a meaningful description"
    );
    Assert.equal(
      checkbox.checked,
      checkedBefore,
      "clicking the ? does not toggle the neighbouring checkbox"
    );

    doc.body.click();
    Assert.ok(
      !doc.querySelector(".perm-popover"),
      "popover closes on outside click"
    );

    // Regression check: long permission names (USERS_READ_ONLINE_STATUS) must
    // not push the "?" affordance out of its grid cell onto the neighbouring
    // checkbox. Reproduced originally at ~660px wide permission editors.
    const permsWrap = doc.querySelector(".perms-expand");
    const labels = [...permsWrap.querySelectorAll(".perm-check-label")];
    Assert.greater(labels.length, 0, "permission grid renders labels");
    permsWrap.style.width = "660px";
    for (const l of labels) {
      const name = l.textContent.replace("?", "").trim();
      const cellRect = l.getBoundingClientRect();
      const helpRect = l.querySelector(".perm-help").getBoundingClientRect();
      Assert.lessOrEqual(
        Math.round(helpRect.right),
        Math.round(cellRect.right) + 1,
        `"?" for ${name} stays inside its grid cell`
      );
      Assert.lessOrEqual(
        l.scrollWidth,
        l.clientWidth + 1,
        `no horizontal overflow in the ${name} cell`
      );
    }
    permsWrap.style.width = "";
  });
});
