/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Asserts that no Mozilla-account (FxA/Sync) UI is reachable in Vento.
 * Only the vento_backend account system must be visible to users.
 */

"use strict";

const { CustomizableUITestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/CustomizableUITestUtils.sys.mjs"
);
const gCUITestUtils = new CustomizableUITestUtils(window);

add_task(async function test_fxa_pref_disabled() {
  Assert.equal(
    Services.prefs.getBoolPref("identity.fxaccounts.enabled"),
    false,
    "identity.fxaccounts.enabled must be false in Vento branding"
  );
});

add_task(async function test_sidebar_has_no_syncedtabs_tool() {
  const { SidebarController } = window;
  const tools = [...(SidebarController.toolsAndExtensions?.keys() ?? [])];
  info(`toolsAndExtensions: ${JSON.stringify(tools)}`);
  Assert.ok(
    !tools.includes("viewTabsSidebar") && !tools.includes("syncedtabs"),
    "sidebar launcher must not offer the synced tabs tool"
  );
  Assert.ok(
    !SidebarController.sidebars.has("viewTabsSidebar"),
    "viewTabsSidebar must not be registered while FxA is disabled"
  );
  Assert.ok(
    !Services.prefs
      .getStringPref("sidebar.main.tools", "")
      .includes("syncedtabs"),
    "default sidebar tools must not include syncedtabs"
  );
});

add_task(async function test_appmenu_has_no_fxa_items() {
  const fxaButton = document.getElementById("fxa-toolbar-menu-button");
  const buttonVisible =
    fxaButton &&
    !fxaButton.hidden &&
    window.getComputedStyle(fxaButton).display !== "none";
  Assert.ok(
    !buttonVisible,
    "FxA toolbar button must be absent or not rendered"
  );

  await gCUITestUtils.openMainMenu();
  const appMenuIds = [
    "appMenu-fxa-status2",
    "appMenu-fxa-status",
    "appMenu-signin-button",
    "appMenu-fxa-separator",
  ];
  for (const id of appMenuIds) {
    const el = document.getElementById(id);
    const visible = el && !el.hidden && el.getBoundingClientRect().width > 0;
    let state = "absent";
    if (el) {
      state = visible ? "VISIBLE" : "hidden";
    }
    info(`app menu element ${id}: ${state}`);
    Assert.ok(!visible, `${id} must not be visible in the app menu`);
  }
  await gCUITestUtils.hideMainMenu();
});

add_task(async function test_history_menu_no_synced_tabs() {
  const el = document.getElementById("appMenu-library-syncedTabs-button");
  const visible = el && !el.hidden;
  Assert.ok(!visible, "History > Synced tabs entry must be absent or hidden");
});

add_task(async function test_preferences_has_no_sync_pane() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const state = await SpecialPowers.spawn(browser, [], () => {
      const syncCategory = content.document.getElementById("category-sync");
      return {
        present: !!syncCategory,
        hidden: syncCategory
          ? syncCategory.hidden ||
            content.getComputedStyle(syncCategory).display === "none"
          : true,
      };
    });
    info(`about:preferences category-sync: ${JSON.stringify(state)}`);
    Assert.ok(
      !state.present || state.hidden,
      "Sync category must not be visible in about:preferences"
    );
  });
});
