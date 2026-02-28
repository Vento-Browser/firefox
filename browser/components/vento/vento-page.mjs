/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  classMap,
  html,
  when,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";

const VENTO_TOKEN_PREF = "browser.logingate.accessToken";
const VENTO_API_URL_PREF = "browser.logingate.serverUrl";
const ALL_PERMS = ["USERS_READ", "USERS_MANAGE", "USERS_PERMISSIONS", "ADMIN"];
const PER_PAGE = 50;

const NAV_PAGES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "users", label: "Users", perm: "USERS_READ" },
  { id: "profile", label: "Profile" },
];

export class VentoPage extends MozLitElement {
  // Render into light DOM so document-level CSS from vento-page.html applies.
  createRenderRoot() {
    return this;
  }

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
    this.createForm = {
      email: "",
      display_name: "",
      password: "",
      temporary_password: false,
    };
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
    this.showCreateForm = false;
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
    this.showCreateForm = false;
  }

  #cancelEditPerms() {
    this.editingUserId = null;
  }

  #togglePerm(perm) {
    if (this.editingPerms.includes(perm)) {
      this.editingPerms = this.editingPerms.filter(p => p !== perm);
    } else {
      this.editingPerms = [...this.editingPerms, perm];
    }
  }

  #openCreateForm() {
    this.createForm = {
      email: "",
      display_name: "",
      password: "",
      temporary_password: false,
    };
    this.createError = "";
    this.showCreateForm = true;
    this.editingUserId = null;
  }

  #updateCreateField(field, value) {
    this.createForm = { ...this.createForm, [field]: value };
  }

  async #submitCreateUser() {
    const { email, display_name, password, temporary_password } =
      this.createForm;
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
      this.#showStatus("User created successfully.");
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

  #logout() {
    Services.prefs.setStringPref(VENTO_TOKEN_PREF, "");
    this.authUser = null;
    this.activePage = "dashboard";
  }

  // ── Render ───────────────────────────────────────────────

  render() {
    const visiblePages = NAV_PAGES.filter(
      p => !p.perm || this.#hasPermission(p.perm)
    );
    const pageTitle =
      NAV_PAGES.find(p => p.id === this.activePage)?.label ?? "Vento";

    return html`
      <div id="full">
        <div id="sidebar">
          <div id="categories">
            ${when(
              !!this.authUser,
              () =>
                visiblePages.map(
                  p => html`
                    <button
                      class=${classMap({
                        category: true,
                        selected: this.activePage === p.id,
                      })}
                      name=${p.id}
                      @click=${() => this.#navigate(p.id)}
                    >
                      <span class="category-name">${p.label}</span>
                    </button>
                  `
                )
            )}
          </div>
          <div class="spacer"></div>
        </div>

        <div id="content">
          ${when(
            !!this.authUser,
            () => html`
              <div class="sticky-container">
                <div class="main-heading">
                  <h1 class="header-name">${pageTitle}</h1>
                </div>
              </div>
            `
          )}
          <div id="main">
            ${when(!this.#token, () => this.#notAuthTpl())}
            ${when(
              !!this.#token && !this.authUser,
              () => html`
                <div class="loading-state">
                  <div class="spinner"></div>
                </div>
              `
            )}
            ${when(!!this.authUser, () => this.#appTpl())}
          </div>
        </div>
      </div>
    `;
  }

  // ── Not authenticated ────────────────────────────────────

  #notAuthTpl() {
    return html`
      <div class="not-auth">
        <h2>Not authenticated</h2>
        <p>
          Set the <code>browser.logingate.accessToken</code> preference to your
          JWT access token.
        </p>
      </div>
    `;
  }

  // ── Authenticated shell ──────────────────────────────────

  #appTpl() {
    return html`
      ${when(
        this.statusMsg,
        () => html`
          <div class="status-banner status-banner-${this.statusMsg.type}">
            ${this.statusMsg.text}
          </div>
        `
      )}
      ${this.#pageTpl()}
    `;
  }

  #pageTpl() {
    switch (this.activePage) {
      case "users":
        return this.#usersPage();
      case "profile":
        return this.#profilePage();
      default:
        return this.#dashboardPage();
    }
  }

  // ── Dashboard ────────────────────────────────────────────

  #dashboardPage() {
    return html`<div class="dashboard-empty">Dashboard — coming soon.</div>`;
  }

  // ── Profile ──────────────────────────────────────────────

  #profilePage() {
    const u = this.authUser;
    return html`
      <moz-card heading="Account">
        <div class="addon-detail-row">
          <span class="info-label">Display name</span>
          <span>${u.display_name}</span>
        </div>
        <div class="addon-detail-row">
          <span class="info-label">Email</span>
          <span>${u.email}</span>
        </div>
        <div class="addon-detail-row">
          <span class="info-label">Permissions</span>
          <div class="perm-badges">
            ${u.permissions.length
              ? u.permissions.map(
                  p => html`<span class="badge badge-perm">${p}</span>`
                )
              : html`<span
                  style="color:var(--text-color-deemphasized,gray)"
                  >—</span
                >`}
          </div>
        </div>
      </moz-card>
      <moz-button @click=${() => this.#logout()}>Log out</moz-button>
    `;
  }

  // ── Users ────────────────────────────────────────────────

  #usersPage() {
    const totalPages = Math.ceil(this.usersTotal / PER_PAGE) || 1;
    const canManage = this.#hasPermission("USERS_MANAGE");
    const canEditPerms = this.#hasPermission("USERS_PERMISSIONS");
    const hasAnyAction = canManage || canEditPerms;

    return html`
      ${when(this.showCreateForm, () => this.#createUserForm())}

      <div class="users-toolbar">
        <span class="users-count">
          ${this.usersTotal}
          ${this.usersTotal === 1 ? "user" : "users"}
        </span>
        ${when(
          canManage && !this.showCreateForm,
          () => html`
            <moz-button
              type="primary"
              @click=${() => this.#openCreateForm()}
            >
              New user
            </moz-button>
          `
        )}
      </div>

      ${when(
        this.isLoading,
        () => html`
          <div class="loading-state"><div class="spinner"></div></div>
        `
      )}
      ${when(
        !this.isLoading,
        () => html`
          <table class="vento-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Permissions</th>
                ${when(hasAnyAction, () => html`<th class="col-actions"></th>`)}
              </tr>
            </thead>
            <tbody>
              ${this.users.map(u =>
                this.#userRow(u, canManage, canEditPerms, hasAnyAction)
              )}
            </tbody>
          </table>

          ${when(
            totalPages > 1,
            () => html`
              <div class="pagination">
                <moz-button
                  type="ghost"
                  size="small"
                  ?disabled=${this.usersPage <= 1}
                  @click=${() => this.#loadUsers(this.usersPage - 1)}
                  iconsrc="chrome://global/skin/icons/arrow-left.svg"
                ></moz-button>
                <span>${this.usersPage} / ${totalPages}</span>
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

  #userRow(u, canManage, canEditPerms, hasAnyAction) {
    const isSelf = u.id === this.authUser?.user_id;
    const isEditing = this.editingUserId === u.id;
    const showEdit = canEditPerms && !isSelf;
    const showToggle = canManage && !isSelf;

    return html`
      <tr class=${classMap({ "editing-row": isEditing })}>
        <td>
          <div class="user-name-cell">
            <span class="user-name">${u.display_name}</span>
            ${when(
              u.totp_enabled,
              () => html`<span class="badge badge-totp">2FA</span>`
            )}
          </div>
        </td>
        <td>${u.email}</td>
        <td>
          <span
            class="badge ${u.is_active ? "badge-active" : "badge-inactive"}"
          >
            ${u.is_active ? "Active" : "Inactive"}
          </span>
        </td>
        <td>
          ${u.permissions.length
            ? html`
                <div class="perm-badges">
                  ${u.permissions.map(
                    p => html`<span class="badge badge-perm">${p}</span>`
                  )}
                </div>
              `
            : html`<span
                style="color:var(--text-color-deemphasized,gray)"
                >—</span
              >`}
        </td>
        ${when(
          hasAnyAction,
          () => html`
            <td class="col-actions">
              <div class="row-actions">
                ${when(
                  showEdit,
                  () => html`
                    <moz-button
                      type="ghost"
                      size="small"
                      @click=${() =>
                        isEditing
                          ? this.#cancelEditPerms()
                          : this.#startEditPerms(u)}
                    >
                      ${isEditing ? "Cancel" : "Edit"}
                    </moz-button>
                  `
                )}
                ${when(
                  showToggle,
                  () => html`
                    <moz-button
                      type="ghost"
                      size="small"
                      @click=${() => this.#setUserActive(u.id, !u.is_active)}
                    >
                      ${u.is_active ? "Deactivate" : "Activate"}
                    </moz-button>
                  `
                )}
              </div>
            </td>
          `
        )}
      </tr>

      ${when(
        isEditing,
        () => html`
          <tr class="edit-expand-row">
            <td colspan="5">
              <div class="perms-expand">
                <div class="perms-expand-label">Permissions</div>
                <div class="perms-grid">
                  ${ALL_PERMS.map(
                    perm => html`
                      <label class="perm-check-label">
                        <input
                          type="checkbox"
                          .checked=${this.editingPerms.includes(perm)}
                          @change=${() => this.#togglePerm(perm)}
                        />
                        ${perm}
                      </label>
                    `
                  )}
                </div>
                <div class="perms-actions">
                  <moz-button
                    type="primary"
                    size="small"
                    @click=${() => this.#savePerms(u.id)}
                  >
                    Save
                  </moz-button>
                  <moz-button
                    type="ghost"
                    size="small"
                    @click=${() => this.#cancelEditPerms()}
                  >
                    Cancel
                  </moz-button>
                </div>
              </div>
            </td>
          </tr>
        `
      )}
    `;
  }

  // ── Create user form ─────────────────────────────────────

  #createUserForm() {
    return html`
      <moz-card heading="New user">
        <div class="form-grid">
          <div class="form-field">
            <label>Display name</label>
            <input
              class="vento-input"
              type="text"
              .value=${this.createForm.display_name}
              @input=${e =>
                this.#updateCreateField("display_name", e.target.value)}
            />
          </div>
          <div class="form-field">
            <label>Email</label>
            <input
              class="vento-input"
              type="email"
              .value=${this.createForm.email}
              @input=${e => this.#updateCreateField("email", e.target.value)}
            />
          </div>
          <div class="form-field">
            <label>Password</label>
            <input
              class="vento-input"
              type="password"
              .value=${this.createForm.password}
              @input=${e => this.#updateCreateField("password", e.target.value)}
            />
          </div>
        </div>
        <label class="form-check-row">
          <input
            type="checkbox"
            .checked=${this.createForm.temporary_password}
            @change=${e =>
              this.#updateCreateField("temporary_password", e.target.checked)}
          />
          Temporary password (user must change on first login)
        </label>
        ${when(
          this.createError,
          () => html`<div class="form-error">${this.createError}</div>`
        )}
        <div class="form-actions">
          <moz-button
            type="primary"
            size="small"
            ?disabled=${this.createLoading}
            @click=${() => this.#submitCreateUser()}
          >
            Create user
          </moz-button>
          <moz-button
            type="ghost"
            size="small"
            @click=${() => {
              this.showCreateForm = false;
            }}
          >
            Cancel
          </moz-button>
        </div>
      </moz-card>
    `;
  }
}

customElements.define("vento-page", VentoPage);
