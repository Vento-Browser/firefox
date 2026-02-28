/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  classMap,
  html,
  when,
} from "chrome://global/content/vendor/lit.all.mjs";
import { SidebarPage } from "./sidebar-page.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/sidebar/sidebar-panel-header.mjs";

const VENTO_TOKEN_PREF = "browser.logingate.accessToken";
const VENTO_API_URL_PREF = "browser.logingate.serverUrl";
const ALL_PERMS = ["USERS_READ", "USERS_MANAGE", "USERS_PERMISSIONS", "ADMIN"];
const PER_PAGE = 15;

export class SidebarVento extends SidebarPage {
  static properties = {
    activePage: { type: String },
    isLoading: { type: Boolean },
    authUser: { type: Object },
    users: { type: Array },
    usersPage: { type: Number },
    usersTotal: { type: Number },
    editingUserId: { type: Number },
    editingPerms: { type: Array },
    statusMsg: { type: Object },
    showCreateForm: { type: Boolean },
    createForm: { type: Object },
    createLoading: { type: Boolean },
    createError: { type: String },
  };

  constructor() {
    super();
    this.activePage = "dashboard";
    this.isLoading = false;
    this.authUser = null;
    this.users = [];
    this.usersPage = 1;
    this.usersTotal = 0;
    this.editingUserId = null;
    this.editingPerms = [];
    this.statusMsg = null;
    this.showCreateForm = false;
    this.createForm = { email: "", display_name: "", password: "", temporary_password: false };
    this.createLoading = false;
    this.createError = "";
  }

  get #apiBase() {
    return Services.prefs.getStringPref(
      VENTO_API_URL_PREF,
      "http://localhost:3000"
    );
  }

  get #token() {
    return Services.prefs.getStringPref(VENTO_TOKEN_PREF, "");
  }

  async connectedCallback() {
    super.connectedCallback();
    await this.#loadCurrentUser();
  }

  async #api(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    const token = this.#token;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${this.#apiBase}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data;
  }

  async #loadCurrentUser() {
    if (!this.#token) {
      return;
    }
    try {
      this.authUser = await this.#api("/api/auth/validate");
    } catch {
      this.authUser = null;
    }
  }

  #hasPermission(perm) {
    return this.authUser?.permissions?.includes(perm) ?? false;
  }

  #navigate(page) {
    this.activePage = page;
    this.editingUserId = null;
    this.statusMsg = null;
    if (page === "users") {
      this.#loadUsers(1);
    }
  }

  #showStatus(text, type = "success") {
    this.statusMsg = { text, type };
    setTimeout(() => {
      this.statusMsg = null;
    }, 3500);
  }

  async #loadUsers(page) {
    this.isLoading = true;
    this.usersPage = page;
    try {
      const data = await this.#api(
        `/api/auth/users?page=${page}&per_page=${PER_PAGE}`
      );
      this.users = data.users;
      this.usersTotal = data.total;
    } catch (e) {
      this.#showStatus(e.message, "error");
    } finally {
      this.isLoading = false;
    }
  }

  async #setUserActive(userId, isActive) {
    try {
      await this.#api(`/api/auth/users/${userId}/active`, {
        method: "PUT",
        body: { is_active: isActive },
      });
      this.#showStatus(isActive ? "User activated." : "User deactivated.");
      await this.#loadUsers(this.usersPage);
    } catch (e) {
      this.#showStatus(e.message, "error");
    }
  }

  #startEditPerms(user) {
    this.editingUserId = user.id;
    this.editingPerms = [...user.permissions];
  }

  #togglePerm(perm) {
    if (this.editingPerms.includes(perm)) {
      this.editingPerms = this.editingPerms.filter(p => p !== perm);
    } else {
      this.editingPerms = [...this.editingPerms, perm];
    }
  }

  #openCreateForm() {
    this.createForm = { email: "", display_name: "", password: "", temporary_password: false };
    this.createError = "";
    this.showCreateForm = true;
    this.editingUserId = null;
  }

  #updateCreateField(field, value) {
    this.createForm = { ...this.createForm, [field]: value };
  }

  async #submitCreateUser() {
    const { email, display_name, password, temporary_password } = this.createForm;
    if (!email || !display_name || !password) {
      this.createError = "All fields are required.";
      return;
    }
    if (password.length < 8) {
      this.createError = "Password must be at least 8 characters.";
      return;
    }
    this.createLoading = true;
    this.createError = "";
    try {
      await this.#api("/api/auth/users", {
        method: "POST",
        body: { email, display_name, password, temporary_password },
      });
      this.showCreateForm = false;
      this.#showStatus("User created.");
      await this.#loadUsers(1);
    } catch (e) {
      this.createError = e.message;
    } finally {
      this.createLoading = false;
    }
  }

  async #savePerms(userId) {
    try {
      await this.#api(`/api/auth/users/${userId}/permissions`, {
        method: "PUT",
        body: { permissions: this.editingPerms },
      });
      this.editingUserId = null;
      this.#showStatus("Permissions updated.");
      await this.#loadUsers(this.usersPage);
    } catch (e) {
      this.#showStatus(e.message, "error");
    }
  }

  // ── Templates ───────────────────────────────────────────

  render() {
    return html`
      ${this.stylesheet()}
      <link
        rel="stylesheet"
        href="chrome://browser/content/sidebar/sidebar-vento.css"
      />
      <sidebar-panel-header
        view="viewVentoSidebar"
        data-l10n-id="sidebar-vento-panel-header"
        data-l10n-attrs="heading"
      ></sidebar-panel-header>
      <div class="vento-panel">
        ${when(!this.#token, () => this.#notAuthTemplate())}
        ${when(
          !!this.#token && !this.authUser,
          () => this.#loadingTemplate()
        )}
        ${when(!!this.authUser, () => this.#appTemplate())}
      </div>
    `;
  }

  #notAuthTemplate() {
    return html`
      <div class="vento-state vento-not-auth">
        <img
          src="chrome://global/skin/icons/info.svg"
          class="vento-state-icon"
        />
        <p class="vento-state-title" data-l10n-id="sidebar-vento-not-auth-title"></p>
        <p class="vento-state-desc" data-l10n-id="sidebar-vento-not-auth-desc"></p>
      </div>
    `;
  }

  #loadingTemplate() {
    return html`
      <div class="vento-state">
        <div class="vento-spinner"></div>
      </div>
    `;
  }

  #appTemplate() {
    return html`
      ${this.#navTemplate()}
      ${when(
        this.statusMsg,
        () => html`
          <div class="vento-status vento-status-${this.statusMsg.type}">
            ${this.statusMsg.text}
          </div>
        `
      )}
      <div class="vento-content">${this.#pageTemplate()}</div>
    `;
  }

  #navTemplate() {
    const pages = [
      { id: "dashboard", labelL10n: "sidebar-vento-nav-dashboard" },
      { id: "profile", labelL10n: "sidebar-vento-nav-profile" },
      ...(this.#hasPermission("USERS_READ")
        ? [{ id: "users", labelL10n: "sidebar-vento-nav-users" }]
        : []),
    ];
    return html`
      <nav class="vento-nav">
        ${pages.map(
          p => html`
            <button
              class=${classMap({
                "vento-nav-btn": true,
                active: this.activePage === p.id,
              })}
              data-l10n-id=${p.labelL10n}
              @click=${() => this.#navigate(p.id)}
            ></button>
          `
        )}
      </nav>
    `;
  }

  #pageTemplate() {
    switch (this.activePage) {
      case "profile":
        return this.#profilePage();
      case "users":
        return this.#usersPage();
      default:
        return this.#dashboardPage();
    }
  }

  #dashboardPage() {
    return html`
      <moz-card>
        <div class="vento-dashboard-empty" data-l10n-id="sidebar-vento-dashboard-empty"></div>
      </moz-card>
    `;
  }

  #profilePage() {
    const u = this.authUser;
    return html`
      <moz-card>
        <dl class="vento-dl">
          <dt data-l10n-id="sidebar-vento-profile-email"></dt>
          <dd>${u.email}</dd>
          <dt data-l10n-id="sidebar-vento-profile-name"></dt>
          <dd>${u.display_name}</dd>
          <dt data-l10n-id="sidebar-vento-profile-permissions"></dt>
          <dd class="vento-perm-list">
            ${u.permissions.length
              ? u.permissions.map(
                  p => html`<span class="vento-badge vento-badge-perm">${p}</span>`
                )
              : html`<span class="vento-muted">—</span>`}
          </dd>
        </dl>
      </moz-card>
    `;
  }

  #usersPage() {
    const totalPages = Math.ceil(this.usersTotal / PER_PAGE) || 1;
    const canManage = this.#hasPermission("USERS_MANAGE");
    return html`
      ${when(
        canManage,
        () => html`
          ${when(
            !this.showCreateForm,
            () => html`
              <moz-button
                type="primary"
                data-l10n-id="sidebar-vento-action-create-user"
                @click=${() => this.#openCreateForm()}
                style="align-self:flex-start"
              ></moz-button>
            `
          )}
          ${when(this.showCreateForm, () => this.#createUserForm())}
        `
      )}
      ${when(
        this.isLoading,
        () => html`
          <div class="vento-state" style="flex:unset;padding:var(--space-large,16px)">
            <div class="vento-spinner"></div>
          </div>
        `
      )}
      ${when(
        !this.isLoading,
        () => html`
          ${this.users.map(u => this.#userCard(u))}
          ${when(
            totalPages > 1,
            () => html`
              <div class="vento-pagination">
                <moz-button
                  type="ghost"
                  size="small"
                  ?disabled=${this.usersPage <= 1}
                  @click=${() => this.#loadUsers(this.usersPage - 1)}
                  iconsrc="chrome://global/skin/icons/arrow-left.svg"
                ></moz-button>
                <span class="vento-page-info">
                  ${this.usersPage} / ${totalPages}
                </span>
                <moz-button
                  type="ghost"
                  size="small"
                  ?disabled=${this.usersPage >= totalPages}
                  @click=${() => this.#loadUsers(this.usersPage + 1)}
                  iconsrc="chrome://global/skin/icons/arrow-right.svg"
                ></moz-button>
              </div>
            `
          )}
        `
      )}
    `;
  }

  #createUserForm() {
    return html`
      <moz-card class="vento-create-form">
        <div class="vento-form-row">
          <label class="vento-form-label" data-l10n-id="sidebar-vento-field-email"></label>
          <input
            class="vento-input"
            type="email"
            .value=${this.createForm.email}
            @input=${e => this.#updateCreateField("email", e.target.value)}
          />
        </div>
        <div class="vento-form-row">
          <label class="vento-form-label" data-l10n-id="sidebar-vento-field-name"></label>
          <input
            class="vento-input"
            type="text"
            .value=${this.createForm.display_name}
            @input=${e => this.#updateCreateField("display_name", e.target.value)}
          />
        </div>
        <div class="vento-form-row">
          <label class="vento-form-label" data-l10n-id="sidebar-vento-field-password"></label>
          <input
            class="vento-input"
            type="password"
            .value=${this.createForm.password}
            @input=${e => this.#updateCreateField("password", e.target.value)}
          />
        </div>
        <label class="vento-perm-check" style="margin-block:var(--space-xsmall,4px)">
          <input
            type="checkbox"
            .checked=${this.createForm.temporary_password}
            @change=${e => this.#updateCreateField("temporary_password", e.target.checked)}
          />
          <span data-l10n-id="sidebar-vento-field-temp-pw"></span>
        </label>
        ${when(
          this.createError,
          () => html`<div class="vento-status vento-status-error">${this.createError}</div>`
        )}
        <div class="vento-perms-actions" style="margin-block-start:var(--space-small,8px)">
          <moz-button
            type="primary"
            size="small"
            ?disabled=${this.createLoading}
            data-l10n-id="sidebar-vento-action-save"
            @click=${() => this.#submitCreateUser()}
          ></moz-button>
          <moz-button
            type="ghost"
            size="small"
            data-l10n-id="sidebar-vento-action-cancel"
            @click=${() => { this.showCreateForm = false; }}
          ></moz-button>
        </div>
      </moz-card>
    `;
  }

  #userCard(u) {
    const isSelf = u.id === this.authUser.user_id;
    const isEditingThis = this.editingUserId === u.id;
    const canEditPerms = this.#hasPermission("USERS_PERMISSIONS") && !isSelf;
    const canManage = this.#hasPermission("USERS_MANAGE") && !isSelf;

    return html`
      <moz-card class="vento-user-card">
        <div class="vento-user-header">
          <div class="vento-user-info">
            <span class="vento-user-name">${u.display_name}</span>
            <span class="vento-user-email">${u.email}</span>
          </div>
          <div class="vento-user-badges">
            <span
              class="vento-badge ${u.is_active
                ? "vento-badge-ok"
                : "vento-badge-off"}"
              data-l10n-id=${u.is_active
                ? "sidebar-vento-user-active"
                : "sidebar-vento-user-inactive"}
            ></span>
            ${when(
              u.totp_enabled,
              () => html`<span class="vento-badge vento-badge-totp">2FA</span>`
            )}
          </div>
        </div>
        ${when(
          u.permissions.length > 0,
          () => html`
            <div class="vento-perm-list">
              ${u.permissions.map(
                p => html`
                  <span class="vento-badge vento-badge-perm">${p}</span>
                `
              )}
            </div>
          `
        )}
        ${when(
          !isEditingThis && (canEditPerms || canManage),
          () => html`
            <div class="vento-user-actions">
              ${when(
                canEditPerms,
                () => html`
                  <moz-button
                    type="ghost"
                    size="small"
                    data-l10n-id="sidebar-vento-action-edit-perms"
                    @click=${() => this.#startEditPerms(u)}
                  ></moz-button>
                `
              )}
              ${when(
                canManage,
                () => html`
                  <moz-button
                    type="ghost"
                    size="small"
                    data-l10n-id=${u.is_active
                      ? "sidebar-vento-action-deactivate"
                      : "sidebar-vento-action-activate"}
                    @click=${() => this.#setUserActive(u.id, !u.is_active)}
                  ></moz-button>
                `
              )}
            </div>
          `
        )}
        ${when(
          isEditingThis,
          () => html`
            <div class="vento-perms-editor">
              ${ALL_PERMS.map(
                perm => html`
                  <label class="vento-perm-check">
                    <input
                      type="checkbox"
                      .checked=${this.editingPerms.includes(perm)}
                      @change=${() => this.#togglePerm(perm)}
                    />
                    ${perm}
                  </label>
                `
              )}
              <div class="vento-perms-actions">
                <moz-button
                  type="primary"
                  size="small"
                  data-l10n-id="sidebar-vento-action-save"
                  @click=${() => this.#savePerms(u.id)}
                ></moz-button>
                <moz-button
                  type="ghost"
                  size="small"
                  data-l10n-id="sidebar-vento-action-cancel"
                  @click=${() => {
                    this.editingUserId = null;
                  }}
                ></moz-button>
              </div>
            </div>
          `
        )}
      </moz-card>
    `;
  }
}

customElements.define("sidebar-vento", SidebarVento);
