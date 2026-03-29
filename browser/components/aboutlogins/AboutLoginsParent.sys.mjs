/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// _AboutLogins is only exported for testing
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { E10SUtils } from "resource://gre/modules/E10SUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LoginBreaches: "resource:///modules/LoginBreaches.sys.mjs",
  LoginCSVImport: "resource://gre/modules/LoginCSVImport.sys.mjs",
  LoginExport: "resource://gre/modules/LoginExport.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  UIState: "resource://services-sync/UIState.sys.mjs",
  FxAccounts: "resource://gre/modules/FxAccounts.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  return lazy.LoginHelper.createLogger("AboutLoginsParent");
});
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "BREACH_ALERTS_ENABLED",
  "signon.management.page.breach-alerts.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "FXA_ENABLED",
  "identity.fxaccounts.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "VULNERABLE_PASSWORDS_ENABLED",
  "signon.management.page.vulnerable-passwords.enabled",
  false
);
ChromeUtils.defineLazyGetter(lazy, "AboutLoginsL10n", () => {
  return new Localization(["branding/brand.ftl", "browser/aboutLogins.ftl"]);
});

const ABOUT_LOGINS_ORIGIN = "about:logins";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PRIMARY_PASSWORD_NOTIFICATION_ID = "primary-password-login-required";

// about:logins will always use the privileged content process,
// even if it is disabled for other consumers such as about:newtab.
const EXPECTED_ABOUTLOGINS_REMOTE_TYPE = E10SUtils.PRIVILEGEDABOUT_REMOTE_TYPE;
let _gPasswordRemaskTimeout = null;
const convertSubjectToLogin = subject => {
  subject.QueryInterface(Ci.nsILoginMetaInfo).QueryInterface(Ci.nsILoginInfo);
  const login = lazy.LoginHelper.loginToVanillaObject(subject);
  if (!lazy.LoginHelper.isUserFacingLogin(login)) {
    return null;
  }
  return augmentVanillaLoginObject(login);
};

const SUBDOMAIN_REGEX = new RegExp(/^www\d*\./);
const augmentVanillaLoginObject = login => {
  // Note that `displayOrigin` can also include a httpRealm.
  let title = login.displayOrigin.replace(SUBDOMAIN_REGEX, "");
  return Object.assign({}, login, {
    title,
  });
};

function getVentoCredentials() {
  try {
    const serverUrl = Services.prefs.getStringPref(
      "browser.logingate.serverUrl",
      ""
    );
    const accessToken = Services.prefs.getStringPref(
      "browser.logingate.accessToken",
      ""
    );
    if (!serverUrl || !accessToken) {
      return null;
    }
    return { serverUrl, accessToken };
  } catch (e) {
    return null;
  }
}

async function ventoFetch(path, opts = {}) {
  const creds = getVentoCredentials();
  if (!creds) {
    throw new Error("Vento not configured");
  }
  const { serverUrl, accessToken } = creds;
  const base = serverUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (opts.body) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(base + path, { ...opts, headers });
  if (!resp.ok) {
    throw new Error(`Vento API error ${resp.status}`);
  }
  if (resp.status === 204 || resp.headers.get("content-length") === "0") {
    return null;
  }
  return resp.json();
}

function ventoLoginToVanilla(record) {
  const displayOrigin =
    record.origin + (record.http_realm ? ` (${record.http_realm})` : "");
  const title = displayOrigin.replace(SUBDOMAIN_REGEX, "");
  return {
    guid: record.guid,
    origin: record.origin,
    displayOrigin,
    title,
    formActionOrigin: record.form_action_origin ?? "",
    httpRealm: record.http_realm ?? null,
    username: record.username ?? "",
    password: record.is_hidden ? "" : (record.password ?? ""),
    usernameField: record.username_field ?? "",
    passwordField: record.password_field ?? "",
    timeCreated: record.time_created ?? Date.now(),
    timeLastUsed: record.time_last_used ?? Date.now(),
    timePasswordChanged: record.time_password_changed ?? Date.now(),
    timesUsed: record.times_used ?? 0,
  };
}

function vanillaToVentoRecord(login) {
  return {
    guid: login.guid,
    origin: login.origin,
    form_action_origin: login.formActionOrigin ?? "",
    http_realm: login.httpRealm ?? null,
    username: login.username ?? "",
    password: login.password ?? "",
    username_field: login.usernameField ?? "",
    password_field: login.passwordField ?? "",
    time_created: login.timeCreated ?? Date.now(),
    time_last_used: login.timeLastUsed ?? Date.now(),
    time_password_changed: login.timePasswordChanged ?? Date.now(),
    times_used: login.timesUsed ?? 0,
    deleted: false,
  };
}

const EXPORT_PASSWORD_OS_AUTH_DIALOG_MESSAGE_IDS = {
  win: "about-logins-export-password-os-auth-dialog-message2-win",
  macosx: "about-logins-export-password-os-auth-dialog-message2-macosx",
};

export class AboutLoginsParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (!this.browsingContext.embedderElement) {
      return;
    }

    // Only respond to messages sent from a privlegedabout process. Ideally
    // we would also check the contentPrincipal.originNoSuffix but this
    // check has been removed due to bug 1576722.
    if (
      this.browsingContext.embedderElement.remoteType !=
      EXPECTED_ABOUTLOGINS_REMOTE_TYPE
    ) {
      throw new Error(
        `AboutLoginsParent: Received ${message.name} message the remote type didn't match expectations: ${this.browsingContext.embedderElement.remoteType} == ${EXPECTED_ABOUTLOGINS_REMOTE_TYPE}`
      );
    }

    AboutLogins.subscribers.add(this.browsingContext);

    switch (message.name) {
      case "AboutLogins:CreateLogin": {
        await this.#createLogin(message.data.login);
        break;
      }
      case "AboutLogins:DeleteLogin": {
        await this.#deleteLogin(message.data.login);
        break;
      }
      case "AboutLogins:SortChanged": {
        this.#sortChanged(message.data);
        break;
      }
      case "AboutLogins:SyncEnable": {
        this.#syncEnable();
        break;
      }
      case "AboutLogins:ImportFromBrowser": {
        this.#importFromBrowser();
        break;
      }
      case "AboutLogins:ImportReportInit": {
        this.#importReportInit();
        break;
      }
      case "AboutLogins:GetHelp": {
        this.#getHelp();
        break;
      }
      case "AboutLogins:OpenPreferences": {
        this.#openPreferences();
        break;
      }
      case "AboutLogins:PrimaryPasswordRequest": {
        await this.#primaryPasswordRequest(
          message.data.messageId,
          message.data.reason
        );
        break;
      }
      case "AboutLogins:Subscribe": {
        await this.#subscribe();
        break;
      }
      case "AboutLogins:UpdateLogin": {
        await this.#updateLogin(message.data.login);
        break;
      }
      case "AboutLogins:ExportPasswords": {
        await this.#exportPasswords();
        break;
      }
      case "AboutLogins:ImportFromFile": {
        await this.#importFromFile();
        break;
      }
      case "AboutLogins:RemoveAllLogins": {
        await this.#removeAllLogins();
        break;
      }
      case "AboutLogins:VentoGetAccess": {
        await this.#ventoGetAccess(message.data);
        break;
      }
      case "AboutLogins:VentoSetAccess": {
        await this.#ventoSetAccess(message.data);
        break;
      }
      case "AboutLogins:VentoGetHistory": {
        await this.#ventoGetHistory(message.data);
        break;
      }
      case "AboutLogins:VentoRollback": {
        await this.#ventoRollback(message.data);
        break;
      }
    }
  }

  get #ownerGlobal() {
    return this.browsingContext.embedderElement?.ownerGlobal;
  }

  async #createLogin(newLogin) {
    let origin = lazy.LoginHelper.getLoginOrigin(newLogin.origin);
    if (!origin) {
      console.error(
        "AboutLogins:CreateLogin: Unable to get an origin from the login details."
      );
      return;
    }
    try {
      const guid = await ventoFetch("/api/browser-logins/manual", {
        method: "POST",
        body: JSON.stringify({
          origin,
          username: newLogin.username || "",
          password: newLogin.password || "",
          username_field: "",
          password_field: "",
        }),
      });
      const now = Date.now();
      const vanilla = ventoLoginToVanilla({
        guid,
        origin,
        form_action_origin: "",
        http_realm: null,
        username: newLogin.username || "",
        password: newLogin.password || "",
        username_field: "",
        password_field: "",
        time_created: now,
        time_last_used: now,
        time_password_changed: now,
        times_used: 0,
      });
      AboutLogins.notifyLoginAdded(vanilla);
      this.#ventoGetAllMeta().catch(e =>
        lazy.log.debug("Vento metadata refresh after create failed:", e)
      );
    } catch (e) {
      lazy.log.warn("AboutLogins: Create login failed:", e);
    }
  }

  get preselectedLogin() {
    const preselectedLogin =
      this.#ownerGlobal?.gBrowser.selectedTab.getAttribute("preselect-login") ||
      this.browsingContext.currentURI?.ref;
    this.#ownerGlobal?.gBrowser.selectedTab.removeAttribute("preselect-login");
    return preselectedLogin || null;
  }

  async #deleteLogin(loginObject) {
    try {
      await ventoFetch(
        `/api/browser-logins/${encodeURIComponent(loginObject.guid)}`,
        { method: "DELETE" }
      );
      AboutLogins.notifyLoginRemoved(loginObject);
    } catch (e) {
      lazy.log.warn("AboutLogins: Delete login failed:", e);
    }
  }

  #sortChanged(sort) {
    Services.prefs.setCharPref("signon.management.page.sort", sort);
  }

  #syncEnable() {
    this.#ownerGlobal.gSync.openFxAEmailFirstPage("password-manager");
  }

  #importFromBrowser() {
    try {
      lazy.MigrationUtils.showMigrationWizard(this.#ownerGlobal, {
        entrypoint: lazy.MigrationUtils.MIGRATION_ENTRYPOINTS.PASSWORDS,
      });
    } catch (ex) {
      console.error(ex);
    }
  }

  #importReportInit() {
    let reportData = lazy.LoginCSVImport.lastImportReport;
    this.sendAsyncMessage("AboutLogins:ImportReportData", reportData);
  }

  #getHelp() {
    const SUPPORT_URL =
      Services.urlFormatter.formatURLPref("app.support.baseURL") +
      "password-manager-remember-delete-edit-logins";
    this.#ownerGlobal.openWebLinkIn(SUPPORT_URL, "tab", {
      relatedToCurrent: true,
    });
  }

  #openPreferences() {
    this.#ownerGlobal.openPreferences("privacy-logins");
  }

  async #primaryPasswordRequest(messageId, reason) {
    if (!messageId) {
      throw new Error("AboutLogins:PrimaryPasswordRequest: no messageId.");
    }
    let messageText = { value: "NOT SUPPORTED" };
    let captionText = { value: "" };

    const isOSAuthEnabled = lazy.LoginHelper.getOSAuthEnabled();

    // This feature is only supported on Windows and macOS
    // but we still call in to OSKeyStore on Linux to get
    // the proper auth_details for Telemetry.
    // See bug 1614874 for Linux support.
    if (isOSAuthEnabled) {
      messageId += "-" + AppConstants.platform;
      [messageText, captionText] = await lazy.AboutLoginsL10n.formatMessages([
        {
          id: messageId,
        },
        {
          id: "about-logins-os-auth-dialog-caption",
        },
      ]);
    }

    let { isAuthorized, telemetryEvent } = await lazy.LoginHelper.requestReauth(
      this.browsingContext.embedderElement,
      isOSAuthEnabled,
      AboutLogins._authExpirationTime,
      messageText.value,
      captionText.value,
      reason
    );
    this.sendAsyncMessage("AboutLogins:PrimaryPasswordResponse", {
      result: isAuthorized,
      telemetryEvent,
    });
    if (isAuthorized) {
      AboutLogins._authExpirationTime = Date.now() + AUTH_TIMEOUT_MS;
      const remaskPasswords = () => {
        this.sendAsyncMessage("AboutLogins:RemaskPassword");
      };
      clearTimeout(_gPasswordRemaskTimeout);
      _gPasswordRemaskTimeout = setTimeout(remaskPasswords, AUTH_TIMEOUT_MS);
    }
  }

  async #subscribe() {
    AboutLogins._authExpirationTime = Number.NEGATIVE_INFINITY;
    AboutLogins.addObservers();

    const logins = await AboutLogins.getAllLogins();
    try {
      let syncState = await AboutLogins.getSyncState();

      let selectedSort = Services.prefs.getCharPref(
        "signon.management.page.sort",
        "name"
      );
      if (selectedSort == "breached") {
        // The "breached" value was used since Firefox 70 and
        // replaced with "alerts" in Firefox 76.
        selectedSort = "alerts";
      }
      this.sendAsyncMessage("AboutLogins:Setup", {
        logins,
        selectedSort,
        syncState,
        primaryPasswordEnabled: lazy.LoginHelper.isPrimaryPasswordSet(),
        passwordRevealVisible: Services.policies.isAllowed("passwordReveal"),
        importVisible:
          Services.policies.isAllowed("profileImport") &&
          AppConstants.platform != "linux",
        preselectedLogin: this.preselectedLogin,
      });

      this.#ventoGetAllMeta().catch(e =>
        lazy.log.debug("Vento metadata fetch failed:", e)
      );

      await AboutLogins.sendAllLoginRelatedObjects(
        logins,
        this.browsingContext
      );
    } catch (ex) {
      if (ex.result != Cr.NS_ERROR_NOT_INITIALIZED) {
        throw ex;
      }

      // The message manager may be destroyed before the replies can be sent.
      lazy.log.debug(
        "AboutLogins:Subscribe: exception when replying with logins",
        ex
      );
    }
  }

  async #updateLogin(loginUpdates) {
    const ventoMeta = loginUpdates.ventoMeta;
    if (
      ventoMeta &&
      ventoMeta.is_owner === false &&
      ventoMeta.can_update === true &&
      loginUpdates.hasOwnProperty("password")
    ) {
      try {
        await ventoFetch(
          `/api/browser-logins/${encodeURIComponent(loginUpdates.guid)}/password`,
          {
            method: "PUT",
            body: JSON.stringify({ password: loginUpdates.password }),
          }
        );
        const current = AboutLogins.getCachedLogin(loginUpdates.guid);
        if (current) {
          AboutLogins.notifyLoginModified(
            Object.assign({}, current, {
              password: loginUpdates.password,
              timePasswordChanged: Date.now(),
            })
          );
        }
      } catch (e) {
        lazy.log.warn("AboutLogins: Shared login password update failed:", e);
      }
      return;
    }

    const current = AboutLogins.getCachedLogin(loginUpdates.guid);
    if (!current) {
      lazy.log.warn(
        `AboutLogins:UpdateLogin: no cached login for guid: ${loginUpdates.guid}`
      );
      return;
    }

    const updates = {};
    if (loginUpdates.hasOwnProperty("username")) {
      updates.username = loginUpdates.username;
    }
    if (loginUpdates.hasOwnProperty("password")) {
      updates.password = loginUpdates.password;
      updates.timePasswordChanged = Date.now();
    }
    if (loginUpdates.hasOwnProperty("origin")) {
      updates.origin = loginUpdates.origin;
    }

    const record = vanillaToVentoRecord(Object.assign({}, current, updates));
    try {
      const resp = await ventoFetch("/api/browser-logins/sync", {
        method: "POST",
        body: JSON.stringify({ logins: [record] }),
      });
      const updated = (resp.logins || []).find(
        l => l.guid === loginUpdates.guid
      );
      AboutLogins.notifyLoginModified(
        updated
          ? ventoLoginToVanilla(updated)
          : Object.assign({}, current, updates)
      );
    } catch (e) {
      lazy.log.warn("AboutLogins: Update login failed:", e);
    }
  }

  async #exportPasswords() {
    let messageText = { value: "NOT SUPPORTED" };
    let captionText = { value: "" };

    const isOSAuthEnabled = lazy.LoginHelper.getOSAuthEnabled();

    // This feature is only supported on Windows and macOS
    // but we still call in to OSKeyStore on Linux to get
    // the proper auth_details for Telemetry.
    // See bug 1614874 for Linux support.
    if (isOSAuthEnabled) {
      const messageId =
        EXPORT_PASSWORD_OS_AUTH_DIALOG_MESSAGE_IDS[AppConstants.platform];
      if (!messageId) {
        throw new Error(
          `AboutLoginsParent: Cannot find l10n id for platform ${AppConstants.platform} for export passwords os auth dialog message`
        );
      }
      [messageText, captionText] = await lazy.AboutLoginsL10n.formatMessages([
        {
          id: messageId,
        },
        {
          id: "about-logins-os-auth-dialog-caption",
        },
      ]);
    }

    let reason = "export_logins";
    let { isAuthorized, telemetryEvent } = await lazy.LoginHelper.requestReauth(
      this.browsingContext.embedderElement,
      true,
      null, // Prompt regardless of a recent prompt
      messageText.value,
      captionText.value,
      reason
    );

    let { name, extra = {}, value = null } = telemetryEvent;
    if (value) {
      extra.value = value;
    }
    Glean.pwmgr[name].record(extra);

    if (!isAuthorized) {
      return;
    }

    if (!this.browsingContext.canOpenModalPicker) {
      // Prompting for os auth removed the focus from about:logins.
      // Waiting for about:logins window to re-gain the focus, because only
      // active browsing contexts are allowed to open the file picker.
      await this.sendQuery("AboutLogins:WaitForFocus");
    }

    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    function fpCallback(aResult) {
      if (aResult != Ci.nsIFilePicker.returnCancel) {
        lazy.LoginExport.exportAsCSV(fp.file.path);
        Glean.pwmgr.mgmtMenuItemUsedExportComplete.record();
      }
    }
    let [title, defaultFilename, okButtonLabel, csvFilterTitle] =
      await lazy.AboutLoginsL10n.formatValues([
        {
          id: "about-logins-export-file-picker-title2",
        },
        {
          id: "about-logins-export-file-picker-default-filename2",
        },
        {
          id: "about-logins-export-file-picker-export-button",
        },
        {
          id: "about-logins-export-file-picker-csv-filter-title",
        },
      ]);

    fp.init(this.browsingContext, title, Ci.nsIFilePicker.modeSave);
    fp.appendFilter(csvFilterTitle, "*.csv");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.defaultString = defaultFilename;
    fp.defaultExtension = "csv";
    fp.okButtonLabel = okButtonLabel;
    fp.open(fpCallback);
  }

  async #importFromFile() {
    let [title, okButtonLabel, csvFilterTitle, tsvFilterTitle] =
      await lazy.AboutLoginsL10n.formatValues([
        {
          id: "about-logins-import-file-picker-title2",
        },
        {
          id: "about-logins-import-file-picker-import-button",
        },
        {
          id: "about-logins-import-file-picker-csv-filter-title",
        },
        {
          id: "about-logins-import-file-picker-tsv-filter-title",
        },
      ]);
    let { result, path } = await this.openFilePickerDialog(
      title,
      okButtonLabel,
      [
        {
          title: csvFilterTitle,
          extensionPattern: "*.csv",
        },
        {
          title: tsvFilterTitle,
          extensionPattern: "*.tsv",
        },
      ]
    );

    if (result != Ci.nsIFilePicker.returnCancel) {
      let summary;
      try {
        summary = await lazy.LoginCSVImport.importFromCSV(path);
      } catch (e) {
        console.error(e);
        this.sendAsyncMessage(
          "AboutLogins:ImportPasswordsErrorDialog",
          e.errorType
        );
      }
      if (summary) {
        this.sendAsyncMessage("AboutLogins:ImportPasswordsDialog", summary);
        Glean.pwmgr.mgmtMenuItemUsedImportCsvComplete.record();
      }
    }
  }

  async #removeAllLogins() {
    const logins = AboutLogins.getAllCachedLogins();
    for (const login of logins) {
      try {
        await ventoFetch(
          `/api/browser-logins/${encodeURIComponent(login.guid)}`,
          { method: "DELETE" }
        );
      } catch (e) {
        lazy.log.warn(
          `AboutLogins: Delete all - failed for guid ${login.guid}:`,
          e
        );
      }
    }
    AboutLogins.notifyRemoveAllLogins();
  }

  #handleLoginStorageErrors(login, error) {
    let messageObject = {
      login: augmentVanillaLoginObject(
        lazy.LoginHelper.loginToVanillaObject(login)
      ),
      errorMessage: error.message,
    };

    if (error.message.includes("This login already exists")) {
      // See comment in LoginHelper.createLoginAlreadyExistsError as to
      // why we need to call .toString() on the nsISupportsString.
      messageObject.existingLoginGuid = error.data.toString();
    }

    this.sendAsyncMessage("AboutLogins:ShowLoginItemError", messageObject);
  }

  async openFilePickerDialog(title, okButtonLabel, appendFilters) {
    return new Promise(resolve => {
      let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      fp.init(this.browsingContext, title, Ci.nsIFilePicker.modeOpen);
      for (const appendFilter of appendFilters) {
        fp.appendFilter(appendFilter.title, appendFilter.extensionPattern);
      }
      fp.appendFilters(Ci.nsIFilePicker.filterAll);
      fp.okButtonLabel = okButtonLabel;
      fp.open(async result => {
        resolve({ result, path: fp.file.path });
      });
    });
  }

  async #ventoGetAccess({ guid }) {
    try {
      const [access, usersResp, groupsResp] = await Promise.all([
        ventoFetch(
          `/api/browser-logins/${encodeURIComponent(guid)}/access`
        ),
        ventoFetch(`/api/auth/users?page=1&per_page=1000`),
        ventoFetch(`/api/groups`),
      ]);
      this.sendAsyncMessage("AboutLogins:VentoAccess", {
        guid,
        access,
        users: usersResp.users || usersResp,
        groups: groupsResp.groups || groupsResp,
      });
    } catch (e) {
      this.sendAsyncMessage("AboutLogins:VentoAccess", {
        guid,
        error: e.message,
      });
    }
  }

  async #ventoSetAccess({ guid, userShares, groupShares }) {
    try {
      await ventoFetch(
        `/api/browser-logins/${encodeURIComponent(guid)}/access`,
        {
          method: "PUT",
          body: JSON.stringify({
            user_shares: userShares,
            group_shares: groupShares,
          }),
        }
      );
      this.sendAsyncMessage("AboutLogins:VentoAccessSaved", { guid });
    } catch (e) {
      this.sendAsyncMessage("AboutLogins:VentoAccessSaved", {
        guid,
        error: e.message,
      });
    }
  }

  async #ventoGetHistory({ guid }) {
    try {
      const history = await ventoFetch(
        `/api/browser-logins/${encodeURIComponent(guid)}/history`
      );
      this.sendAsyncMessage("AboutLogins:VentoHistory", { guid, history });
    } catch (e) {
      this.sendAsyncMessage("AboutLogins:VentoHistory", {
        guid,
        error: e.message,
      });
    }
  }

  async #ventoRollback({ guid, historyId }) {
    try {
      await ventoFetch(
        `/api/browser-logins/${encodeURIComponent(guid)}/rollback/${historyId}`,
        { method: "POST" }
      );
      this.sendAsyncMessage("AboutLogins:VentoRollbackDone", { guid });
    } catch (e) {
      this.sendAsyncMessage("AboutLogins:VentoRollbackDone", {
        guid,
        error: e.message,
      });
    }
  }

  async #ventoGetAllMeta() {
    let allLogins = [];
    let page = 1;
    const perPage = 200;
    try {
      while (true) {
        const resp = await ventoFetch(
          `/api/browser-logins?page=${page}&per_page=${perPage}`
        );
        allLogins = allLogins.concat(resp.logins || []);
        if (allLogins.length >= (resp.total || 0)) {
          break;
        }
        page++;
      }
    } catch (e) {
      lazy.log.debug("VentoGetAllMeta failed:", e);
    }
    this.sendAsyncMessage("AboutLogins:VentoAllMeta", allLogins);
  }

  ventoRefreshMeta() {
    return this.#ventoGetAllMeta();
  }
}

class AboutLoginsInternal {
  subscribers = new WeakSet();
  #observersAdded = false;
  authExpirationTime = Number.NEGATIVE_INFINITY;
  #loginCache = new Map();

  async observe(subject, topic, type) {
    if (!ChromeUtils.nondeterministicGetWeakSetKeys(this.subscribers).length) {
      this.#removeObservers();
      return;
    }

    switch (topic) {
      case "passwordmgr-reload-all": {
        await this.#reloadAllLogins();
        break;
      }
      case "passwordmgr-crypto-login": {
        this.#removeNotifications(PRIMARY_PASSWORD_NOTIFICATION_ID);
        await this.#reloadAllLogins();
        break;
      }
      case "passwordmgr-crypto-loginCanceled": {
        this.#showPrimaryPasswordLoginNotifications();
        break;
      }
      case lazy.UIState.ON_UPDATE: {
        this.#messageSubscribers(
          "AboutLogins:SyncState",
          await this.getSyncState()
        );
        break;
      }
      case "passwordmgr-storage-changed": {
        switch (type) {
          case "addLogin": {
            await this.#addLogin(subject);
            break;
          }
          case "modifyLogin": {
            await this.#modifyLogin(subject);
            break;
          }
          case "removeLogin": {
            this.#removeLogin(subject);
            break;
          }
          case "removeAllLogins": {
            await this.#removeAllLogins();
            break;
          }
        }
        break;
      }
      case "vento-login-sync-done": {
        this.#ventoRefreshAllMeta();
        break;
      }
    }
  }

  #ventoRefreshAllMeta() {
    for (let subscriber of this.#subscriberIterator()) {
      if (subscriber.currentWindowGlobal) {
        let actor = subscriber.currentWindowGlobal.getActor("AboutLogins");
        actor.ventoRefreshMeta().catch(e =>
          lazy.log.debug("VentoRefreshMeta failed:", e)
        );
      }
    }
  }

  async #addLogin(subject) {
    const login = convertSubjectToLogin(subject);
    if (!login) {
      return;
    }

    if (lazy.BREACH_ALERTS_ENABLED) {
      this.#messageSubscribers(
        "AboutLogins:UpdateBreaches",
        await lazy.LoginBreaches.getPotentialBreachesByLoginGUID([login])
      );
      if (lazy.VULNERABLE_PASSWORDS_ENABLED) {
        this.#messageSubscribers(
          "AboutLogins:UpdateVulnerableLogins",
          await lazy.LoginBreaches.getPotentiallyVulnerablePasswordsByLoginGUID(
            [login]
          )
        );
      }
    }

    this.#messageSubscribers("AboutLogins:LoginAdded", login);
  }

  async #modifyLogin(subject) {
    subject.QueryInterface(Ci.nsIArrayExtensions);
    const login = convertSubjectToLogin(subject.GetElementAt(1));
    if (!login) {
      return;
    }

    if (lazy.BREACH_ALERTS_ENABLED) {
      let breachesForThisLogin =
        await lazy.LoginBreaches.getPotentialBreachesByLoginGUID([login]);
      let breachData = breachesForThisLogin.size
        ? breachesForThisLogin.get(login.guid)
        : false;
      this.#messageSubscribers(
        "AboutLogins:UpdateBreaches",
        new Map([[login.guid, breachData]])
      );
      if (lazy.VULNERABLE_PASSWORDS_ENABLED) {
        let vulnerablePasswordsForThisLogin =
          await lazy.LoginBreaches.getPotentiallyVulnerablePasswordsByLoginGUID(
            [login]
          );
        let isLoginVulnerable = !!vulnerablePasswordsForThisLogin.size;
        this.#messageSubscribers(
          "AboutLogins:UpdateVulnerableLogins",
          new Map([[login.guid, isLoginVulnerable]])
        );
      }
    }

    this.#messageSubscribers("AboutLogins:LoginModified", login);
  }

  #removeLogin(subject) {
    const login = convertSubjectToLogin(subject);
    if (!login) {
      return;
    }
    this.#messageSubscribers("AboutLogins:LoginRemoved", login);
  }

  async #removeAllLogins() {
    this.#messageSubscribers("AboutLogins:RemoveAllLogins", []);
  }

  async #reloadAllLogins() {
    let logins = await this.getAllLogins();
    this.#messageSubscribers("AboutLogins:AllLogins", logins);
    await this.sendAllLoginRelatedObjects(logins);
  }

  #showPrimaryPasswordLoginNotifications() {
    this.#showNotifications({
      id: PRIMARY_PASSWORD_NOTIFICATION_ID,
      priority: "PRIORITY_WARNING_MEDIUM",
      iconURL: "chrome://browser/skin/login.svg",
      messageId: "about-logins-primary-password-notification-message",
      buttonIds: ["master-password-reload-button"],
      onClicks: [
        function onReloadClick(browser) {
          browser.reload();
        },
      ],
    });
    this.#messageSubscribers("AboutLogins:PrimaryPasswordAuthRequired");
  }

  #showNotifications({
    id,
    priority,
    iconURL,
    messageId,
    buttonIds,
    onClicks,
    extraFtl = [],
  } = {}) {
    for (let subscriber of this.#subscriberIterator()) {
      let browser = subscriber.embedderElement;
      let MozXULElement = browser.ownerGlobal.MozXULElement;
      MozXULElement.insertFTLIfNeeded("browser/aboutLogins.ftl");
      for (let ftl of extraFtl) {
        MozXULElement.insertFTLIfNeeded(ftl);
      }

      // If there's already an existing notification bar, don't do anything.
      let { gBrowser } = browser.ownerGlobal;
      let notificationBox = gBrowser.getNotificationBox(browser);
      let notification = notificationBox.getNotificationWithValue(id);
      if (notification) {
        continue;
      }

      let buttons = [];
      for (let i = 0; i < buttonIds.length; i++) {
        buttons[i] = {
          "l10n-id": buttonIds[i],
          popup: null,
          callback: () => {
            onClicks[i](browser);
          },
        };
      }

      notification = notificationBox.appendNotification(
        id,
        {
          label: { "l10n-id": messageId },
          image: iconURL,
          priority: notificationBox[priority],
        },
        buttons
      );
    }
  }

  #removeNotifications(notificationId) {
    for (let subscriber of this.#subscriberIterator()) {
      let browser = subscriber.embedderElement;
      let { gBrowser } = browser.ownerGlobal;
      let notificationBox = gBrowser.getNotificationBox(browser);
      let notification =
        notificationBox.getNotificationWithValue(notificationId);
      if (!notification) {
        continue;
      }
      notificationBox.removeNotification(notification);
    }
  }

  *#subscriberIterator() {
    let subscribers = ChromeUtils.nondeterministicGetWeakSetKeys(
      this.subscribers
    );
    for (let subscriber of subscribers) {
      let browser = subscriber.embedderElement;
      if (
        browser?.remoteType != EXPECTED_ABOUTLOGINS_REMOTE_TYPE ||
        browser?.contentPrincipal?.originNoSuffix != ABOUT_LOGINS_ORIGIN
      ) {
        this.subscribers.delete(subscriber);
        continue;
      }
      yield subscriber;
    }
  }

  #messageSubscribers(name, details) {
    for (let subscriber of this.#subscriberIterator()) {
      try {
        if (subscriber.currentWindowGlobal) {
          let actor = subscriber.currentWindowGlobal.getActor("AboutLogins");
          actor.sendAsyncMessage(name, details);
        }
      } catch (ex) {
        if (ex.result == Cr.NS_ERROR_NOT_INITIALIZED) {
          // The actor may be destroyed before the message is sent.
          lazy.log.debug(
            "messageSubscribers: exception when calling sendAsyncMessage",
            ex
          );
        } else {
          throw ex;
        }
      }
    }
  }

  async getAllLogins() {
    try {
      const resp = await ventoFetch("/api/browser-logins/sync", {
        method: "POST",
        body: JSON.stringify({ logins: [] }),
      });
      const all = [
        ...(resp.logins || [])
          .filter(r => !r.deleted)
          .map(ventoLoginToVanilla),
        ...(resp.shared_logins || []).map(ventoLoginToVanilla),
      ];
      this.#loginCache.clear();
      for (const l of all) {
        this.#loginCache.set(l.guid, l);
      }
      return all;
    } catch (e) {
      lazy.log.debug("getAllLogins: Vento fetch failed:", e);
      return [];
    }
  }

  getCachedLogin(guid) {
    return this.#loginCache.get(guid) ?? null;
  }

  getAllCachedLogins() {
    return Array.from(this.#loginCache.values());
  }

  notifyLoginAdded(login) {
    this.#loginCache.set(login.guid, login);
    this.#messageSubscribers("AboutLogins:LoginAdded", login);
    this.#ventoRefreshAllMeta();
  }

  notifyLoginModified(login) {
    this.#loginCache.set(login.guid, login);
    this.#messageSubscribers("AboutLogins:LoginModified", login);
    this.#ventoRefreshAllMeta();
  }

  notifyLoginRemoved(login) {
    this.#loginCache.delete(login.guid);
    this.#messageSubscribers("AboutLogins:LoginRemoved", login);
  }

  notifyRemoveAllLogins() {
    this.#loginCache.clear();
    this.#messageSubscribers("AboutLogins:RemoveAllLogins", []);
  }

  async sendAllLoginRelatedObjects(logins, browsingContext) {
    let sendMessageFn = (name, details) => {
      if (browsingContext?.currentWindowGlobal) {
        let actor = browsingContext.currentWindowGlobal.getActor("AboutLogins");
        actor.sendAsyncMessage(name, details);
      } else {
        this.#messageSubscribers(name, details);
      }
    };

    if (lazy.BREACH_ALERTS_ENABLED) {
      sendMessageFn(
        "AboutLogins:SetBreaches",
        await lazy.LoginBreaches.getPotentialBreachesByLoginGUID(logins)
      );
      if (lazy.VULNERABLE_PASSWORDS_ENABLED) {
        sendMessageFn(
          "AboutLogins:SetVulnerableLogins",
          await lazy.LoginBreaches.getPotentiallyVulnerablePasswordsByLoginGUID(
            logins
          )
        );
      }
    }
  }

  async getSyncState() {
    const state = lazy.UIState.get();
    // As long as Sync is configured, about:logins will treat it as
    // authenticated. More diagnostics and error states can be handled
    // by other more Sync-specific pages.
    const loggedIn = state.status != lazy.UIState.STATUS_NOT_CONFIGURED;
    const passwordSyncEnabled = state.syncEnabled && lazy.PASSWORD_SYNC_ENABLED;
    const accountURL =
      await lazy.FxAccounts.config.promiseManageURI("password-manager");

    return {
      loggedIn,
      email: state.email,
      avatarURL: state.avatarURL,
      fxAccountsEnabled: lazy.FXA_ENABLED,
      passwordSyncEnabled,
      accountURL,
    };
  }

  async onPasswordSyncEnabledPreferenceChange(_data, _previous, _latest) {
    this.#messageSubscribers(
      "AboutLogins:SyncState",
      await this.getSyncState()
    );
  }

  #observedTopics = [
    "passwordmgr-crypto-login",
    "passwordmgr-crypto-loginCanceled",
    "passwordmgr-storage-changed",
    "passwordmgr-reload-all",
    "vento-login-sync-done",
    lazy.UIState.ON_UPDATE,
  ];

  addObservers() {
    if (!this.#observersAdded) {
      for (const topic of this.#observedTopics) {
        Services.obs.addObserver(this, topic);
      }
      this.#observersAdded = true;
    }
  }

  #removeObservers() {
    for (const topic of this.#observedTopics) {
      Services.obs.removeObserver(this, topic);
    }
    this.#observersAdded = false;
  }
}

let AboutLogins = new AboutLoginsInternal();
export var _AboutLogins = AboutLogins;

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "PASSWORD_SYNC_ENABLED",
  "services.sync.engine.passwords",
  false,
  AboutLogins.onPasswordSyncEnabledPreferenceChange.bind(AboutLogins)
);
