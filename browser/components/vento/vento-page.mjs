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
const ALL_PERMS = ["USERS_READ", "USERS_MANAGE", "USERS_PERMISSIONS", "ADMIN", "USERS_READ_ONLINE_STATUS"];
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
    userFilter: { type: String },
    editingUserId: { type: Number },
    editingPerms: { type: Array },
    statusMsg: { type: Object },
    showCreateForm: { type: Boolean },
    createForm: { type: Object },
    createLoading: { type: Boolean },
    createError: { type: String },
    createPasswordVisible: { type: Boolean },
    passwordCopied: { type: Boolean },
    dashboardStats: { type: Object },
    dashboardOnlineUsers: { type: Array },
    dashboardLoading: { type: Boolean },
    metricsHistory: { type: Array },
    currentMetrics: { type: Object },
  };

  constructor() {
    super();
    this.activePage = "dashboard";
    this.isLoading = false;
    this.authUser = null;
    this.users = [];
    this.usersPage = 1;
    this.usersTotal = 0;
    this.userFilter = "";
    this.editingUserId = null;
    this.editingPerms = [];
    this.statusMsg = null;
    this.showCreateForm = false;
    this.createForm = {
      email: "",
      display_name: "",
      password: "",
    };
    this.createLoading = false;
    this.createError = "";
    this.createPasswordVisible = false;
    this.passwordCopied = false;
    this.dashboardStats = null;
    this.dashboardOnlineUsers = null;
    this.dashboardLoading = false;
    this.metricsHistory = [];
    this.currentMetrics = null;
    // Non-reactive WS state (not Lit properties).
    this._ws = null;
    this._wsReconnectTimer = null;
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

  get #wsUrl() {
    return this.#apiBase.replace(/^http(s?):\/\//, "ws$1://") + "/ws";
  }

  async connectedCallback() {
    super.connectedCallback();
    await this.#loadCurrentUser();
    if (this.authUser) {
      if (this.activePage === "dashboard") {
        this.#loadDashboard();
      }
      this.#connectWs();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#disconnectWs();
  }

  // ── WebSocket ─────────────────────────────────────────────

  #connectWs() {
    if (this._ws) {
      return;
    }
    const token = this.#token;
    if (!token) {
      return;
    }
    let ws;
    try {
      ws = new WebSocket(this.#wsUrl);
    } catch {
      return;
    }
    this._ws = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
    });

    ws.addEventListener("message", e => {
      try {
        this.#handleWsMessage(JSON.parse(e.data));
      } catch {
        // ignore malformed frames
      }
    });

    ws.addEventListener("close", () => {
      if (this._ws === ws) {
        this._ws = null;
      }
      // Reconnect after 5 s unless the component was unmounted.
      this._wsReconnectTimer = setTimeout(() => {
        this._wsReconnectTimer = null;
        this.#connectWs();
      }, 5000);
    });

    ws.addEventListener("error", () => {
      // close event fires right after — handled there.
    });
  }

  #disconnectWs() {
    if (this._wsReconnectTimer) {
      clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  #handleWsMessage(msg) {
    switch (msg.type) {
      case "metrics_history":
        this.metricsHistory = msg.snapshots ?? [];
        if (this.metricsHistory.length) {
          this.currentMetrics =
            this.metricsHistory[this.metricsHistory.length - 1];
        }
        break;
      case "metrics": {
        const snap = {
          cpu_usage: msg.cpu_usage,
          memory_used_mb: msg.memory_used_mb,
          memory_total_mb: msg.memory_total_mb,
          timestamp: msg.timestamp,
        };
        this.currentMetrics = snap;
        const next = [...this.metricsHistory, snap];
        this.metricsHistory = next.length > 90 ? next.slice(-90) : next;
        break;
      }
    }
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

  async #loadDashboard() {
    this.dashboardLoading = true;
    try {
      this.dashboardStats = await this.#api("/api/auth/dashboard");
      if (
        this.#hasPermission("USERS_READ") &&
        this.#hasPermission("USERS_READ_ONLINE_STATUS")
      ) {
        const data = await this.#api(
          "/api/auth/users?page=1&per_page=200"
        );
        this.dashboardOnlineUsers = data.users.filter(u => u.online);
      }
    } catch {
      // keep previous state on error
    } finally {
      this.dashboardLoading = false;
    }
  }

  #hasPermission(perm) {
    return this.authUser?.permissions?.includes(perm) ?? false;
  }

  #navigate(page) {
    this.activePage = page;
    this.userFilter = "";
    this.editingUserId = null;
    this.statusMsg = null;
    this.showCreateForm = false;
    if (page === "users") {
      this.#loadUsers(1);
    } else if (page === "dashboard") {
      this.#loadDashboard();
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
    };
    this.createError = "";
    this.showCreateForm = true;
    this.editingUserId = null;
    this.createPasswordVisible = false;
    this.passwordCopied = false;
  }

  #generatePassword() {
    const charset =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_=+";
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    const password = Array.from(array, b => charset[b % charset.length]).join(
      ""
    );
    this.createForm = { ...this.createForm, password };
    this.createPasswordVisible = true;
    this.passwordCopied = false;
  }

  async #copyPassword() {
    if (!this.createForm.password) {
      return;
    }
    try {
      await navigator.clipboard.writeText(this.createForm.password);
      this.passwordCopied = true;
      setTimeout(() => {
        this.passwordCopied = false;
      }, 2000);
    } catch {
      // clipboard not available
    }
  }

  #updateCreateField(field, value) {
    this.createForm = { ...this.createForm, [field]: value };
  }

  async #submitCreateUser() {
    const { email, display_name, password } = this.createForm;
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
        body: { email, display_name, password },
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
    this.#disconnectWs();
    Services.prefs.setStringPref(VENTO_TOKEN_PREF, "");
    this.authUser = null;
    this.activePage = "dashboard";
    this.metricsHistory = [];
    this.currentMetrics = null;
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
                <div class="main-search">
                </div>
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
    const count = this.dashboardStats?.online_users_count ?? "—";
    const canSeeWho =
      this.#hasPermission("USERS_READ") &&
      this.#hasPermission("USERS_READ_ONLINE_STATUS");
    const onlineUsers = this.dashboardOnlineUsers ?? [];

    const m = this.currentMetrics;
    const cpuPct = m ? m.cpu_usage.toFixed(1) + "%" : "—";
    const memPct =
      m && m.memory_total_mb
        ? ((m.memory_used_mb / m.memory_total_mb) * 100).toFixed(1) + "%"
        : "—";
    const memLabel =
      m && m.memory_total_mb
        ? `${(m.memory_used_mb / 1024).toFixed(1)} / ${(m.memory_total_mb / 1024).toFixed(1)} GB`
        : "Memory";

    return html`
      <div class="dashboard">
        <div class="dashboard-stat-row">
          <div class="stat-card stat-card--online">
            <span class="stat-value">${count}</span>
            <span class="stat-label">Users online</span>
          </div>
          <div class="stat-card stat-card--cpu">
            <span class="stat-value">${cpuPct}</span>
            <span class="stat-label">CPU</span>
          </div>
          <div class="stat-card stat-card--mem">
            <span class="stat-value">${memPct}</span>
            <span class="stat-label">${memLabel}</span>
          </div>
        </div>

        <moz-card heading="System load · 15 min">
          ${this.#renderMetricsChart()}
        </moz-card>

        ${when(
          canSeeWho,
          () => html`
            <moz-card heading="Online now">
              ${when(
                this.dashboardLoading,
                () => html`
                  <div class="loading-state" style="padding:20px 0">
                    <div class="spinner"></div>
                  </div>
                `,
                () => html`
                  ${when(
                    onlineUsers.length,
                    () => html`
                      <ul class="online-users-list">
                        ${onlineUsers.map(
                          u => html`
                            <li class="online-user-item">
                              <span class="user-avatar">
                                ${u.display_name[0].toUpperCase()}
                              </span>
                              <span class="online-user-name"
                                >${u.display_name}</span
                              >
                              <span class="online-user-email">${u.email}</span>
                            </li>
                          `
                        )}
                      </ul>
                    `,
                    () => html`
                      <p class="dashboard-empty-msg">
                        No users are currently online.
                      </p>
                    `
                  )}
                `
              )}
            </moz-card>
          `
        )}

        <div class="dashboard-refresh">
          <moz-button
            type="ghost"
            size="small"
            @click=${() => this.#loadDashboard()}
          >
            Refresh
          </moz-button>
        </div>
      </div>
    `;
  }

  #renderMetricsChart() {
    const data = this.metricsHistory;
    if (!data.length) {
      return html`<p class="dashboard-empty-msg">Waiting for data…</p>`;
    }

    const W = 900;
    const H = 120;
    const n = data.length;
    const xOf = i => (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const yOf = v => H - (Math.max(0, Math.min(100, v)) / 100) * H;

    const cpuPts = data
      .map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.cpu_usage).toFixed(1)}`)
      .join(" ");
    const memPts = data
      .map((p, i) => {
        const pct =
          p.memory_total_mb > 0
            ? (p.memory_used_mb / p.memory_total_mb) * 100
            : 0;
        return `${xOf(i).toFixed(1)},${yOf(pct).toFixed(1)}`;
      })
      .join(" ");

    // Grid lines at 25 %, 50 %, 75 % — y values with H = 120:
    //   75 % → y = 30,  50 % → y = 60,  25 % → y = 90
    return html`
      <div class="metrics-chart-wrap">
        <svg
          class="metrics-chart"
          viewBox="0 0 900 120"
          preserveAspectRatio="none"
        >
          <line x1="0" y1="30" x2="900" y2="30" class="chart-grid-line"></line>
          <line x1="0" y1="60" x2="900" y2="60" class="chart-grid-line"></line>
          <line x1="0" y1="90" x2="900" y2="90" class="chart-grid-line"></line>
          <polyline
            points=${cpuPts}
            class="chart-line chart-line--cpu"
          ></polyline>
          <polyline
            points=${memPts}
            class="chart-line chart-line--mem"
          ></polyline>
        </svg>
        <div class="chart-legend">
          <span class="chart-legend-item chart-legend-item--cpu">CPU</span>
          <span class="chart-legend-item chart-legend-item--mem">Memory</span>
          <span class="chart-legend-time">← 15 min ago · now →</span>
        </div>
      </div>
    `;
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
    const canSeeOnline = this.#hasPermission("USERS_READ_ONLINE_STATUS");
    const hasAnyAction = canManage || canEditPerms;
    const colCount = hasAnyAction ? 5 : 4;

    // Client-side filter
    const q = this.userFilter.trim().toLowerCase();
    const filtered = q
      ? this.users.filter(
          u =>
            u.display_name.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q)
        )
      : this.users;

    // Split into groups
    let activeUsers = filtered.filter(u => u.is_active);
    const inactiveUsers = filtered.filter(u => !u.is_active);

    // Sort active: online first when we have that permission
    if (canSeeOnline && activeUsers.length) {
      activeUsers = [...activeUsers].sort((a, b) => {
        if (a.online && !b.online) {
          return -1;
        }
        if (!a.online && b.online) {
          return 1;
        }
        return 0;
      });
    }

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

      <div class="users-filter">

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
              <tr class="group-header-row">
                <td colspan=${colCount}>
                  <div class="group-header-cell">
                    <span class="group-header-label">Active</span>
                    <span class="group-header-count"
                      >${activeUsers.length}</span
                    >
                  </div>
                </td>
              </tr>
              ${activeUsers.map(u =>
                this.#userRow(
                  u,
                  canManage,
                  canEditPerms,
                  hasAnyAction,
                  canSeeOnline
                )
              )}
              ${when(
                !!inactiveUsers.length,
                () => html`
                  <tr class="group-header-row">
                    <td colspan=${colCount}>
                      <div class="group-header-cell">
                        <span class="group-header-label">Inactive</span>
                        <span class="group-header-count"
                          >${inactiveUsers.length}</span
                        >
                      </div>
                    </td>
                  </tr>
                  ${inactiveUsers.map(u =>
                    this.#userRow(
                      u,
                      canManage,
                      canEditPerms,
                      hasAnyAction,
                      canSeeOnline
                    )
                  )}
                `
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

  #userRow(u, canManage, canEditPerms, hasAnyAction, canSeeOnline) {
    const isSelf = u.id === this.authUser?.user_id;
    const isEditing = this.editingUserId === u.id;
    const showEdit = canEditPerms && !isSelf;
    const showToggle = canManage && !isSelf;

    let statusCell;
    if (canSeeOnline) {
      if (u.is_active) {
        const isOnline = u.online === true;
        statusCell = html`<span
          class=${classMap({
            "online-dot": true,
            "online-dot--on": isOnline,
            "online-dot--off": !isOnline,
          })}
          title=${isOnline ? "Online" : "Offline"}
        ></span>`;
      } else {
        statusCell = html`<span
          class="online-dot online-dot--inactive"
          title="Inactive"
        ></span>`;
      }
    } else {
      statusCell = html`<span
        class="badge ${u.is_active ? "badge-active" : "badge-inactive"}"
        >${u.is_active ? "Active" : "Inactive"}</span
      >`;
    }

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
        <td>${statusCell}</td>
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
          <div class="form-field password-field">
            <label>Password</label>
            <div class="password-input-row">
              <input
                class="vento-input"
                type=${this.createPasswordVisible ? "text" : "password"}
                .value=${this.createForm.password}
                @input=${e =>
                  this.#updateCreateField("password", e.target.value)}
              />
              <moz-button
                type="ghost"
                size="small"
                @click=${() => this.#generatePassword()}
              >
                Generate
              </moz-button>
              <moz-button
                type="ghost"
                size="small"
                ?disabled=${!this.createForm.password}
                @click=${() => this.#copyPassword()}
              >
                ${this.passwordCopied ? "Copied!" : "Copy"}
              </moz-button>
            </div>
          </div>
        </div>
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
