/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

try {
  ChromeUtils.registerWindowActor("VentoPassword", {
    parent: {
      esModuleURI:
        "chrome://browser/content/vento/VentoPasswordParent.sys.mjs",
    },
    child: {
      esModuleURI:
        "chrome://browser/content/vento/VentoPasswordChild.sys.mjs",
    },
    allFrames: false,
    includeChrome: false,
  });
} catch {
  // Already registered — second about:vento tab opened.
}

const VENTO_TOKEN_PREF = "browser.logingate.accessToken";
const VENTO_API_URL_PREF = "browser.logingate.serverUrl";
const ALL_PERMS = [
  "USERS_READ",
  "USERS_MANAGE",
  "USERS_PERMISSIONS",
  "ADMIN",
  "USERS_READ_ONLINE_STATUS",
  "PASSWORDS_MANAGE",
];
const PER_PAGE = 50;
const PW_PER_PAGE = 50;
const PAGE_TITLES = {
  dashboard: "Dashboard",
  users: "Users",
  groups: "User Groups",
  passwords: "Hidden Passwords",
  profile: "Profile",
};

// ── State ─────────────────────────────────────────────────

let activePage = "dashboard";
let authUser = null;
let users = [];
let usersPage = 1;
let usersTotal = 0;
let editingUserId = null;
let editingPerms = [];
let showCreateForm = false;
let createLoading = false;
let dashboardStats = null;
let dashboardOnlineUsers = null;
let dashboardLoading = false;
let metricsHistory = [];
let currentMetrics = null;
let passwords = [];
let passwordsTotal = 0;
let passwordsPage = 1;
let passwordsLoading = false;
let showCreatePwForm = false;
let createPwLoading = false;
let editingPwId = null;
let accessPasswordId = null;
let accessAllUsers = [];
let accessChecked = [];
let accessAllGroups = [];
let accessCheckedGroups = [];
let accessLoading = false;
// Groups state
let groups = [];
let groupsLoading = false;
let showCreateGroupForm = false;
let editingGroupId = null;
let editingGroupPerms = [];
let renamingGroupId = null;
let membersGroupId = null;
let membersGroupName = "";
let membersAllUsers = [];
let membersChecked = [];
let membersLoading = false;
let isLoading = false;
let _ws = null;
let _wsReconnectTimer = null;
let _statusTimer = null;

// ── DOM helpers ───────────────────────────────────────────

const $ = id => document.getElementById(id);

function clearChildren(el) {
  const node = typeof el === "string" ? $(el) : el;
  while (node.lastChild) {
    node.removeChild(node.lastChild);
  }
}

function makeBadge(text, cls) {
  const span = document.createElement("span");
  span.className = `badge ${cls}`;
  span.textContent = text;
  return span;
}

function makeMozButton(text, type, size) {
  const btn = document.createElement("moz-button");
  btn.setAttribute("type", type);
  if (size) {
    btn.setAttribute("size", size);
  }
  if (text) {
    btn.textContent = text;
  }
  return btn;
}

// ── API ───────────────────────────────────────────────────

function apiBase() {
  return Services.prefs.getStringPref(
    VENTO_API_URL_PREF,
    "http://localhost:3000"
  );
}

function token() {
  return Services.prefs.getStringPref(VENTO_TOKEN_PREF, "");
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  const tok = token();
  if (tok) {
    headers.Authorization = `Bearer ${tok}`;
  }
  const res = await fetch(`${apiBase()}${path}`, {
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

// ── Status banner ─────────────────────────────────────────

function showStatus(text, type = "success") {
  const el = $("status-banner");
  el.textContent = text;
  el.className = `status-banner status-banner-${type}`;
  el.hidden = false;
  clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

// ── WebSocket ─────────────────────────────────────────────

function connectWs() {
  if (_ws) {
    return;
  }
  const tok = token();
  if (!tok) {
    return;
  }
  const wsUrl = apiBase().replace(/^http(s?):\/\//, "ws$1://") + "/ws";
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return;
  }
  _ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "auth", token: tok }));
  });

  ws.addEventListener("message", e => {
    try {
      handleWsMessage(JSON.parse(e.data));
    } catch {
      // ignore malformed frames
    }
  });

  ws.addEventListener("close", () => {
    if (_ws === ws) {
      _ws = null;
    }
    _wsReconnectTimer = setTimeout(() => {
      _wsReconnectTimer = null;
      connectWs();
    }, 5000);
  });
}

function disconnectWs() {
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "metrics_history":
      metricsHistory = msg.snapshots ?? [];
      if (metricsHistory.length) {
        currentMetrics = metricsHistory[metricsHistory.length - 1];
      }
      if (activePage === "dashboard") {
        renderMetrics();
      }
      break;
    case "metrics": {
      const snap = {
        cpu_usage: msg.cpu_usage,
        memory_used_mb: msg.memory_used_mb,
        memory_total_mb: msg.memory_total_mb,
        timestamp: msg.timestamp,
      };
      currentMetrics = snap;
      const next = [...metricsHistory, snap];
      metricsHistory = next.length > 90 ? next.slice(-90) : next;
      if (activePage === "dashboard") {
        renderMetrics();
      }
      break;
    }
  }
}

// ── Navigation ────────────────────────────────────────────

function navigate(page) {
  activePage = page;
  editingUserId = null;
  showCreateForm = false;
  showCreatePwForm = false;
  editingPwId = null;
  editingGroupId = null;
  renamingGroupId = null;
  showCreateGroupForm = false;

  for (const btn of document.querySelectorAll("#categories .category")) {
    btn.classList.toggle("selected", btn.getAttribute("name") === page);
  }
  $("page-title").textContent = PAGE_TITLES[page] ?? "Vento";

  for (const sec of document.querySelectorAll("#main .page")) {
    sec.hidden = true;
  }
  $(`page-${page}`).hidden = false;

  if (page === "users") {
    loadUsers(1);
  } else if (page === "dashboard") {
    loadDashboard();
  } else if (page === "passwords") {
    loadPasswords(1);
  } else if (page === "groups") {
    loadGroups();
  } else if (page === "profile") {
    renderProfile();
  }
}

// ── Auth ──────────────────────────────────────────────────

function hasPerm(perm) {
  return authUser?.permissions?.includes(perm) ?? false;
}

async function loadCurrentUser() {
  if (!token()) {
    return;
  }
  $("loading-init").hidden = false;
  try {
    authUser = await api("/api/auth/validate");
  } catch {
    authUser = null;
  } finally {
    $("loading-init").hidden = true;
  }
}

function renderApp() {
  const tok = token();
  if (!tok) {
    $("not-auth").hidden = false;
    $("full").hidden = true;
    return;
  }
  if (!authUser) {
    $("not-auth").hidden = false;
    $("full").hidden = true;
    return;
  }
  $("not-auth").hidden = true;
  $("full").hidden = false;
  $("nav-users").hidden = !hasPerm("USERS_READ");
  $("nav-groups").hidden = !hasPerm("USERS_MANAGE");
}

function logout() {
  disconnectWs();
  Services.prefs.setStringPref(VENTO_TOKEN_PREF, "");
  authUser = null;
  metricsHistory = [];
  currentMetrics = null;
  renderApp();
  activePage = "dashboard";
}

// ── Dashboard ─────────────────────────────────────────────

async function loadDashboard() {
  dashboardLoading = true;
  renderDashboard();
  try {
    dashboardStats = await api("/api/auth/dashboard");
    if (hasPerm("USERS_READ") && hasPerm("USERS_READ_ONLINE_STATUS")) {
      const data = await api("/api/auth/users?page=1&per_page=200");
      dashboardOnlineUsers = data.users.filter(u => u.online);
    }
  } catch {
    // keep previous state on error
  } finally {
    dashboardLoading = false;
    renderDashboard();
  }
}

function renderDashboard() {
  $("stat-online").textContent =
    dashboardStats?.online_users_count ?? "\u2014";

  const m = currentMetrics;
  $("stat-cpu").textContent = m ? m.cpu_usage.toFixed(1) + "%" : "\u2014";
  if (m && m.memory_total_mb) {
    $("stat-mem").textContent =
      ((m.memory_used_mb / m.memory_total_mb) * 100).toFixed(1) + "%";
    $("stat-mem-label").textContent = `${(m.memory_used_mb / 1024).toFixed(1)} / ${(m.memory_total_mb / 1024).toFixed(1)} GB`;
  } else {
    $("stat-mem").textContent = "\u2014";
    $("stat-mem-label").textContent = "Memory";
  }

  const canSeeWho = hasPerm("USERS_READ") && hasPerm("USERS_READ_ONLINE_STATUS");
  const onlineCard = $("online-users-card");
  onlineCard.hidden = !canSeeWho;

  if (canSeeWho) {
    $("online-users-loading").hidden = !dashboardLoading;
    if (!dashboardLoading) {
      const onlineUsers = dashboardOnlineUsers ?? [];
      const listEl = $("online-users-list");
      clearChildren(listEl);
      if (onlineUsers.length) {
        const tpl = $("tpl-online-user");
        for (const u of onlineUsers) {
          const item = tpl.content.cloneNode(true);
          item.querySelector(".user-avatar").textContent =
            u.display_name[0].toUpperCase();
          item.querySelector(".online-user-name").textContent = u.display_name;
          item.querySelector(".online-user-email").textContent = u.email;
          listEl.appendChild(item);
        }
        listEl.hidden = false;
        $("online-users-empty").hidden = true;
      } else {
        listEl.hidden = true;
        $("online-users-empty").hidden = false;
      }
    }
  }
}

function renderMetrics() {
  const data = metricsHistory;
  if (!data.length) {
    $("metrics-waiting").hidden = false;
    $("metrics-chart-wrap").hidden = true;
    renderDashboard();
    return;
  }
  $("metrics-waiting").hidden = true;
  $("metrics-chart-wrap").hidden = false;

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

  $("chart-cpu").setAttribute("points", cpuPts);
  $("chart-mem").setAttribute("points", memPts);
  renderDashboard();
}

// ── Users ─────────────────────────────────────────────────

async function loadUsers(page) {
  isLoading = true;
  usersPage = page;
  renderUsers();
  try {
    const data = await api(
      `/api/auth/users?page=${page}&per_page=${PER_PAGE}`
    );
    users = data.users;
    usersTotal = data.total;
  } catch (e) {
    showStatus(e.message, "error");
  } finally {
    isLoading = false;
    renderUsers();
  }
}

function renderUsers() {
  const canManage = hasPerm("USERS_MANAGE");
  const canEditPerms = hasPerm("USERS_PERMISSIONS");
  const canSeeOnline = hasPerm("USERS_READ_ONLINE_STATUS");
  const hasAnyAction = canManage || canEditPerms;

  $("users-count").textContent = `${usersTotal} ${usersTotal === 1 ? "user" : "users"}`;
  $("btn-new-user").hidden = !canManage || showCreateForm;
  $("create-user-section").hidden = !showCreateForm;
  $("users-actions-col").hidden = !hasAnyAction;
  $("users-loading").hidden = !isLoading;
  $("users-table").hidden = isLoading;

  if (isLoading) {
    return;
  }

  let activeUsers = users.filter(u => u.is_active);
  const inactiveUsers = users.filter(u => !u.is_active);

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

  const colCount = hasAnyAction ? 5 : 4;
  const tbody = $("users-tbody");
  clearChildren(tbody);

  appendGroupHeader(tbody, "Active", activeUsers.length, colCount);
  for (const u of activeUsers) {
    appendUserRows(tbody, u, canManage, canEditPerms, hasAnyAction, canSeeOnline, colCount);
  }

  if (inactiveUsers.length) {
    appendGroupHeader(tbody, "Inactive", inactiveUsers.length, colCount);
    for (const u of inactiveUsers) {
      appendUserRows(tbody, u, canManage, canEditPerms, hasAnyAction, canSeeOnline, colCount);
    }
  }

  $("users-table").hidden = false;

  const totalPages = Math.ceil(usersTotal / PER_PAGE) || 1;
  $("users-pagination").hidden = totalPages <= 1;
  if (totalPages > 1) {
    $("users-page-info").textContent = `${usersPage} / ${totalPages}`;
    $("users-prev").toggleAttribute("disabled", usersPage <= 1);
    $("users-next").toggleAttribute("disabled", usersPage >= totalPages);
  }
}

function appendGroupHeader(tbody, label, count, colCount) {
  const tr = document.createElement("tr");
  tr.className = "group-header-row";
  const td = document.createElement("td");
  td.colSpan = colCount;
  td.innerHTML = `<div class="group-header-cell"><span class="group-header-label">${label}</span><span class="group-header-count">${count}</span></div>`;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function appendUserRows(
  tbody,
  u,
  canManage,
  canEditPerms,
  hasAnyAction,
  canSeeOnline,
  colCount
) {
  const isSelf = u.id === authUser?.user_id;
  const isEditing = editingUserId === u.id;
  const showEdit = canEditPerms && !isSelf;
  const showToggle = canManage && !isSelf;

  const tr = document.createElement("tr");
  if (isEditing) {
    tr.classList.add("editing-row");
  }

  // Name cell
  const nameCell = document.createElement("td");
  const nameDiv = document.createElement("div");
  nameDiv.className = "user-name-cell";
  const nameSpan = document.createElement("span");
  nameSpan.className = "user-name";
  nameSpan.textContent = u.display_name;
  nameDiv.appendChild(nameSpan);
  if (u.totp_enabled) {
    nameDiv.appendChild(makeBadge("2FA", "badge-totp"));
  }
  nameCell.appendChild(nameDiv);
  tr.appendChild(nameCell);

  // Email cell
  const emailCell = document.createElement("td");
  emailCell.textContent = u.email;
  tr.appendChild(emailCell);

  // Status cell
  const statusCell = document.createElement("td");
  if (canSeeOnline) {
    const dot = document.createElement("span");
    if (u.is_active) {
      dot.className = u.online
        ? "online-dot online-dot--on"
        : "online-dot online-dot--off";
      dot.title = u.online ? "Online" : "Offline";
    } else {
      dot.className = "online-dot online-dot--inactive";
      dot.title = "Inactive";
    }
    statusCell.appendChild(dot);
  } else {
    statusCell.appendChild(
      makeBadge(
        u.is_active ? "Active" : "Inactive",
        u.is_active ? "badge-active" : "badge-inactive"
      )
    );
  }
  tr.appendChild(statusCell);

  // Permissions cell — individual first, then one block per group
  const permsCell = document.createElement("td");
  const hasIndividual = u.individual_permissions?.length > 0;
  const hasGroups = u.groups?.length > 0;

  if (!hasIndividual && !hasGroups) {
    const dash = document.createElement("span");
    dash.style.color = "var(--text-color-deemphasized,gray)";
    dash.textContent = "\u2014";
    permsCell.appendChild(dash);
  } else {
    const wrap = document.createElement("div");
    wrap.className = "user-perms-wrap";

    if (hasIndividual) {
      const div = document.createElement("div");
      div.className = "perm-badges";
      for (const p of u.individual_permissions) {
        div.appendChild(makeBadge(p, "badge-perm"));
      }
      wrap.appendChild(div);
    }

    for (const g of (u.groups ?? [])) {
      if (!g.permissions.length) {
        continue;
      }
      const groupRow = document.createElement("div");
      groupRow.className = "perm-group-row";

      const nameSpan2 = document.createElement("span");
      nameSpan2.className = "perm-group-name";
      nameSpan2.textContent = g.name;
      groupRow.appendChild(nameSpan2);

      const badgesDiv = document.createElement("div");
      badgesDiv.className = "perm-badges";
      for (const p of g.permissions) {
        badgesDiv.appendChild(makeBadge(p, "badge-perm badge-perm-group"));
      }
      groupRow.appendChild(badgesDiv);

      if (canManage) {
        const removeBtn = makeMozButton("Remove", "ghost", "small");
        removeBtn.classList.add("btn-remove-from-group");
        removeBtn.addEventListener("click", () =>
          removeUserFromGroup(u.id, g.id, g.name)
        );
        groupRow.appendChild(removeBtn);
      }

      wrap.appendChild(groupRow);
    }

    permsCell.appendChild(wrap);
  }
  tr.appendChild(permsCell);

  // Actions cell
  if (hasAnyAction) {
    const actCell = document.createElement("td");
    actCell.className = "col-actions";
    const actDiv = document.createElement("div");
    actDiv.className = "row-actions";

    if (showEdit) {
      const btn = makeMozButton(isEditing ? "Cancel" : "Edit", "ghost", "small");
      btn.addEventListener("click", () => {
        if (editingUserId === u.id) {
          cancelEditPerms();
        } else {
          startEditPerms(u);
        }
      });
      actDiv.appendChild(btn);
    }

    if (showToggle) {
      const btn = makeMozButton(
        u.is_active ? "Deactivate" : "Activate",
        "ghost",
        "small"
      );
      btn.addEventListener("click", () => setUserActive(u.id, !u.is_active));
      actDiv.appendChild(btn);
    }

    actCell.appendChild(actDiv);
    tr.appendChild(actCell);
  }

  tbody.appendChild(tr);

  // Permissions expand row
  if (isEditing) {
    const expandTr = document.createElement("tr");
    expandTr.className = "edit-expand-row";
    const expandTd = document.createElement("td");
    expandTd.colSpan = colCount;

    const wrap = document.createElement("div");
    wrap.className = "perms-expand";

    const lbl = document.createElement("div");
    lbl.className = "perms-expand-label";
    lbl.textContent = "Individual permissions";
    wrap.appendChild(lbl);

    const grid = document.createElement("div");
    grid.className = "perms-grid";
    for (const perm of ALL_PERMS) {
      const label = document.createElement("label");
      label.className = "perm-check-label";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = editingPerms.includes(perm);
      cb.addEventListener("change", () => {
        if (editingPerms.includes(perm)) {
          editingPerms = editingPerms.filter(p => p !== perm);
        } else {
          editingPerms = [...editingPerms, perm];
        }
      });
      label.appendChild(cb);
      label.append(` ${perm}`);
      grid.appendChild(label);
    }
    wrap.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "perms-actions";
    const saveBtn = makeMozButton("Save", "primary", "small");
    saveBtn.addEventListener("click", () => savePerms(u.id));
    const cancelBtn = makeMozButton("Cancel", "ghost", "small");
    cancelBtn.addEventListener("click", () => cancelEditPerms());
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);

    expandTd.appendChild(wrap);
    expandTr.appendChild(expandTd);
    tbody.appendChild(expandTr);
  }
}

function startEditPerms(u) {
  editingUserId = u.id;
  editingPerms = [...(u.individual_permissions ?? u.permissions)];
  showCreateForm = false;
  renderUsers();
}

function cancelEditPerms() {
  editingUserId = null;
  renderUsers();
}

async function savePerms(userId) {
  try {
    await api(`/api/auth/users/${userId}/permissions`, {
      method: "PUT",
      body: { permissions: editingPerms },
    });
    editingUserId = null;
    showStatus("Permissions updated.");
    await loadUsers(usersPage);
  } catch (e) {
    showStatus(e.message, "error");
  }
}

async function setUserActive(userId, isActive) {
  try {
    await api(`/api/auth/users/${userId}/active`, {
      method: "PUT",
      body: { is_active: isActive },
    });
    showStatus(isActive ? "User activated." : "User deactivated.");
    await loadUsers(usersPage);
  } catch (e) {
    showStatus(e.message, "error");
  }
}

async function removeUserFromGroup(userId, groupId, groupName) {
  try {
    const members = await api(`/api/groups/${groupId}/members`);
    const newIds = (members.members ?? [])
      .filter(m => m.id !== userId)
      .map(m => m.id);
    await api(`/api/groups/${groupId}/members`, {
      method: "PUT",
      body: { user_ids: newIds },
    });
    showStatus(`Removed from group "${groupName}".`);
    await loadUsers(usersPage);
  } catch (e) {
    showStatus(e.message, "error");
  }
}

function openCreateForm() {
  $("cu-name").value = "";
  $("cu-email").value = "";
  $("cu-password").value = "";
  $("cu-password").type = "password";
  $("create-user-error").hidden = true;
  showCreateForm = true;
  editingUserId = null;
  renderUsers();
}

function generatePassword() {
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_=+";
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const pw = Array.from(array, b => charset[b % charset.length]).join("");
  $("cu-password").value = pw;
  $("cu-password").type = "text";
  $("btn-copy-password").textContent = "Copy";
}

async function copyPassword() {
  const pw = $("cu-password").value;
  if (!pw) {
    return;
  }
  try {
    await navigator.clipboard.writeText(pw);
    $("btn-copy-password").textContent = "Copied!";
    setTimeout(() => {
      $("btn-copy-password").textContent = "Copy";
    }, 2000);
  } catch {
    // clipboard not available
  }
}

async function submitCreateUser() {
  const email = $("cu-email").value.trim();
  const display_name = $("cu-name").value.trim();
  const password = $("cu-password").value;
  const errorEl = $("create-user-error");

  if (!email || !display_name || !password) {
    errorEl.textContent = "All fields are required.";
    errorEl.hidden = false;
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = "Password must be at least 8 characters.";
    errorEl.hidden = false;
    return;
  }

  errorEl.hidden = true;
  createLoading = true;
  $("btn-create-user").toggleAttribute("disabled", true);
  try {
    await api("/api/auth/users", {
      method: "POST",
      body: { email, display_name, password },
    });
    showCreateForm = false;
    showStatus("User created successfully.");
    await loadUsers(1);
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  } finally {
    createLoading = false;
    $("btn-create-user").toggleAttribute("disabled", false);
    renderUsers();
  }
}

// ── Groups ────────────────────────────────────────────────

async function loadGroups() {
  groupsLoading = true;
  renderGroups();
  try {
    const data = await api("/api/groups");
    groups = data.groups ?? [];
  } catch (e) {
    showStatus(e.message, "error");
  } finally {
    groupsLoading = false;
    renderGroups();
  }
}

function renderGroups() {
  $("groups-count").textContent = `${groups.length} ${groups.length === 1 ? "group" : "groups"}`;
  $("btn-new-group").hidden = showCreateGroupForm;
  $("create-group-section").hidden = !showCreateGroupForm;
  $("groups-loading").hidden = !groupsLoading;
  $("groups-table").hidden = groupsLoading;

  if (groupsLoading) {
    return;
  }

  const tbody = $("groups-tbody");
  clearChildren(tbody);

  if (!groups.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.cssText =
      "text-align:center;padding:24px;color:var(--text-color-deemphasized,gray)";
    td.textContent = "No groups yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const g of groups) {
      appendGroupRow(tbody, g);
    }
  }

  $("groups-table").hidden = false;
}

function appendGroupRow(tbody, g) {
  const isEditing = editingGroupId === g.id;
  const isRenaming = renamingGroupId === g.id;

  const tr = document.createElement("tr");
  if (isEditing || isRenaming) {
    tr.classList.add("editing-row");
  }

  // Name
  const nameTd = document.createElement("td");
  if (isRenaming) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vento-input inline-rename-input";
    input.value = g.name;
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") saveRenameGroup(g.id, input.value);
      if (e.key === "Escape") cancelRenameGroup();
    });
    nameTd.appendChild(input);
    requestAnimationFrame(() => input.focus());
  } else {
    nameTd.textContent = g.name;
  }
  tr.appendChild(nameTd);

  // Member count
  const membersTd = document.createElement("td");
  membersTd.textContent = g.member_count;
  tr.appendChild(membersTd);

  // Permissions
  const permsTd = document.createElement("td");
  if (g.permissions.length) {
    const div = document.createElement("div");
    div.className = "perm-badges";
    for (const p of g.permissions) {
      div.appendChild(makeBadge(p, "badge-perm"));
    }
    permsTd.appendChild(div);
  } else {
    const dash = document.createElement("span");
    dash.style.color = "var(--text-color-deemphasized,gray)";
    dash.textContent = "\u2014";
    permsTd.appendChild(dash);
  }
  tr.appendChild(permsTd);

  // Actions
  const actTd = document.createElement("td");
  actTd.className = "col-actions";
  const actDiv = document.createElement("div");
  actDiv.className = "row-actions";

  const renameBtn = makeMozButton(isRenaming ? "Cancel" : "Rename", "ghost", "small");
  renameBtn.addEventListener("click", () => {
    if (isRenaming) {
      cancelRenameGroup();
    } else {
      startRenameGroup(g.id);
    }
  });
  actDiv.appendChild(renameBtn);

  if (isRenaming) {
    const saveRenameBtn = makeMozButton("Save", "primary", "small");
    saveRenameBtn.addEventListener("click", () => {
      const input = tr.querySelector(".inline-rename-input");
      saveRenameGroup(g.id, input?.value ?? "");
    });
    actDiv.appendChild(saveRenameBtn);
  }

  const editPermsBtn = makeMozButton(
    isEditing ? "Cancel" : "Edit permissions",
    "ghost",
    "small"
  );
  editPermsBtn.addEventListener("click", () => {
    if (editingGroupId === g.id) {
      cancelEditGroupPerms();
    } else {
      startEditGroupPerms(g);
    }
  });
  actDiv.appendChild(editPermsBtn);

  const membersBtn = makeMozButton("Members", "ghost", "small");
  membersBtn.addEventListener("click", () => openMembersDialog(g));
  actDiv.appendChild(membersBtn);

  const deleteBtn = makeMozButton("Delete", "ghost", "small");
  deleteBtn.addEventListener("click", () => deleteGroup(g.id, g.name));
  actDiv.appendChild(deleteBtn);

  actTd.appendChild(actDiv);
  tr.appendChild(actTd);
  tbody.appendChild(tr);

  // Permissions expand row
  if (isEditing) {
    const expandTr = document.createElement("tr");
    expandTr.className = "edit-expand-row";
    const expandTd = document.createElement("td");
    expandTd.colSpan = 4;

    const wrap = document.createElement("div");
    wrap.className = "perms-expand";

    const lbl = document.createElement("div");
    lbl.className = "perms-expand-label";
    lbl.textContent = "Group permissions";
    wrap.appendChild(lbl);

    const grid = document.createElement("div");
    grid.className = "perms-grid";
    for (const perm of ALL_PERMS) {
      const label = document.createElement("label");
      label.className = "perm-check-label";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = editingGroupPerms.includes(perm);
      cb.addEventListener("change", () => {
        if (editingGroupPerms.includes(perm)) {
          editingGroupPerms = editingGroupPerms.filter(p => p !== perm);
        } else {
          editingGroupPerms = [...editingGroupPerms, perm];
        }
      });
      label.appendChild(cb);
      label.append(` ${perm}`);
      grid.appendChild(label);
    }
    wrap.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "perms-actions";
    const saveBtn = makeMozButton("Save", "primary", "small");
    saveBtn.addEventListener("click", () => saveGroupPerms(g.id));
    const cancelBtn = makeMozButton("Cancel", "ghost", "small");
    cancelBtn.addEventListener("click", () => cancelEditGroupPerms());
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);

    expandTd.appendChild(wrap);
    expandTr.appendChild(expandTd);
    tbody.appendChild(expandTr);
  }
}

function startEditGroupPerms(g) {
  editingGroupId = g.id;
  editingGroupPerms = [...g.permissions];
  renderGroups();
}

function cancelEditGroupPerms() {
  editingGroupId = null;
  renderGroups();
}

function startRenameGroup(groupId) {
  renamingGroupId = groupId;
  editingGroupId = null;
  renderGroups();
}

function cancelRenameGroup() {
  renamingGroupId = null;
  renderGroups();
}

async function saveRenameGroup(groupId, name) {
  name = name.trim();
  if (!name) return;
  try {
    await api(`/api/groups/${groupId}`, { method: "PUT", body: { name } });
    renamingGroupId = null;
    showStatus("Group renamed.");
    await loadGroups();
  } catch (e) {
    showStatus(e.message, "error");
  }
}

async function saveGroupPerms(groupId) {
  try {
    await api(`/api/groups/${groupId}/permissions`, {
      method: "PUT",
      body: { permissions: editingGroupPerms },
    });
    editingGroupId = null;
    showStatus("Group permissions updated.");
    await loadGroups();
  } catch (e) {
    showStatus(e.message, "error");
  }
}

async function deleteGroup(groupId, groupName) {
  try {
    await api(`/api/groups/${groupId}`, { method: "DELETE" });
    showStatus(`Group "${groupName}" deleted.`);
    await loadGroups();
  } catch (e) {
    showStatus(e.message, "error");
  }
}

function openCreateGroupForm() {
  $("cg-name").value = "";
  $("create-group-error").hidden = true;
  showCreateGroupForm = true;
  editingGroupId = null;
  renderGroups();
}

async function submitCreateGroup() {
  const name = $("cg-name").value.trim();
  const errorEl = $("create-group-error");

  if (!name) {
    errorEl.textContent = "Group name is required.";
    errorEl.hidden = false;
    return;
  }

  errorEl.hidden = true;
  $("btn-create-group").toggleAttribute("disabled", true);
  try {
    await api("/api/groups", {
      method: "POST",
      body: { name },
    });
    showCreateGroupForm = false;
    showStatus("Group created.");
    await loadGroups();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  } finally {
    $("btn-create-group").toggleAttribute("disabled", false);
    renderGroups();
  }
}

// ── Group members dialog ───────────────────────────────────

async function openMembersDialog(g) {
  membersGroupId = g.id;
  membersGroupName = g.name;
  membersAllUsers = [];
  membersChecked = [];
  $("members-overlay").hidden = false;
  $("members-title").textContent = `Members \u2014 ${g.name}`;
  $("members-filter").value = "";
  $("members-loading").hidden = false;
  clearChildren("members-user-list");
  membersLoading = true;
  try {
    const [membersData, usersData] = await Promise.all([
      api(`/api/groups/${g.id}/members`),
      api(`/api/auth/users?page=1&per_page=500`),
    ]);
    membersChecked = (membersData.members ?? []).map(m => m.id);
    membersAllUsers = usersData.users ?? [];
  } catch (e) {
    showStatus(e.message, "error");
    $("members-overlay").hidden = true;
    return;
  } finally {
    membersLoading = false;
    $("members-loading").hidden = true;
  }
  renderMembersUserList();
}

function renderMembersUserList() {
  const q = $("members-filter").value.trim().toLowerCase();
  const filtered = q
    ? membersAllUsers.filter(
        u =>
          u.display_name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
      )
    : membersAllUsers;

  const listEl = $("members-user-list");
  clearChildren(listEl);

  if (!filtered.length) {
    const p = document.createElement("p");
    p.style.cssText =
      "color:var(--text-color-deemphasized,gray);font-size:13px;margin:8px 0";
    p.textContent = "No users found.";
    listEl.appendChild(p);
    return;
  }

  for (const u of filtered) {
    const lbl = document.createElement("label");
    lbl.className = "access-user-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = membersChecked.includes(u.id);
    cb.addEventListener("change", () => {
      if (membersChecked.includes(u.id)) {
        membersChecked = membersChecked.filter(id => id !== u.id);
      } else {
        membersChecked = [...membersChecked, u.id];
      }
    });
    const nameSpan = document.createElement("span");
    nameSpan.className = "access-user-name";
    nameSpan.textContent = u.display_name;
    const emailSpan = document.createElement("span");
    emailSpan.className = "access-user-email";
    emailSpan.textContent = u.email;
    lbl.appendChild(cb);
    lbl.appendChild(nameSpan);
    lbl.appendChild(emailSpan);
    listEl.appendChild(lbl);
  }
}

function closeMembersDialog() {
  $("members-overlay").hidden = true;
  membersGroupId = null;
}

async function saveGroupMembers() {
  $("btn-save-members").toggleAttribute("disabled", true);
  try {
    await api(`/api/groups/${membersGroupId}/members`, {
      method: "PUT",
      body: { user_ids: membersChecked },
    });
    $("members-overlay").hidden = true;
    showStatus("Group members saved.");
    await loadGroups();
  } catch (e) {
    showStatus(e.message, "error");
  } finally {
    $("btn-save-members").toggleAttribute("disabled", false);
  }
}

// ── Passwords ─────────────────────────────────────────────

async function loadPasswords(page) {
  passwordsLoading = true;
  passwordsPage = page;
  $("pw-loading").hidden = false;
  $("pw-table").hidden = true;
  try {
    const data = await api(
      `/api/passwords?page=${page}&per_page=${PW_PER_PAGE}`
    );
    passwords = data.passwords;
    passwordsTotal = data.total;
  } catch (e) {
    showStatus(e.message, "error");
  } finally {
    passwordsLoading = false;
    renderPasswords();
  }
}

function renderPasswords() {
  const canManage = hasPerm("PASSWORDS_MANAGE");
  const totalPages = Math.ceil(passwordsTotal / PW_PER_PAGE) || 1;

  $("pw-count").textContent = `${passwordsTotal} ${passwordsTotal === 1 ? "entry" : "entries"}`;
  $("btn-new-pw").hidden = !canManage || showCreatePwForm;
  $("create-pw-section").hidden = !showCreatePwForm;
  $("pw-loading").hidden = !passwordsLoading;
  $("pw-table").hidden = passwordsLoading;

  if (passwordsLoading) {
    return;
  }

  const tbody = $("pw-tbody");
  clearChildren(tbody);

  if (!passwords.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.style.cssText =
      "text-align:center;padding:24px;color:var(--text-color-deemphasized,gray)";
    td.textContent = "No entries yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const pw of passwords) {
      appendPwRows(tbody, pw, canManage);
    }
  }

  $("pw-table").hidden = false;

  $("pw-pagination").hidden = totalPages <= 1;
  if (totalPages > 1) {
    $("pw-page-info").textContent = `${passwordsPage} / ${totalPages}`;
    $("pw-prev").toggleAttribute("disabled", passwordsPage <= 1);
    $("pw-next").toggleAttribute("disabled", passwordsPage >= totalPages);
  }
}

function appendPwRows(tbody, pw, canManage) {
  const isEditing = editingPwId === pw.id;

  const tr = document.createElement("tr");
  if (isEditing) {
    tr.classList.add("editing-row");
  }

  const titleTd = document.createElement("td");
  titleTd.textContent = pw.title;
  tr.appendChild(titleTd);

  const urlTd = document.createElement("td");
  if (pw.url) {
    const a = document.createElement("a");
    a.href = pw.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "pw-url-link";
    a.textContent = pw.url;
    urlTd.appendChild(a);
  } else {
    const dash = document.createElement("span");
    dash.style.color = "var(--text-color-deemphasized,gray)";
    dash.textContent = "\u2014";
    urlTd.appendChild(dash);
  }
  tr.appendChild(urlTd);

  const usernameTd = document.createElement("td");
  if (pw.username) {
    usernameTd.textContent = pw.username;
  } else {
    const dash = document.createElement("span");
    dash.style.color = "var(--text-color-deemphasized,gray)";
    dash.textContent = "\u2014";
    usernameTd.appendChild(dash);
  }
  tr.appendChild(usernameTd);

  const actTd = document.createElement("td");
  actTd.className = "col-actions";
  const actDiv = document.createElement("div");
  actDiv.className = "row-actions";

  if (canManage) {
    const editBtn = makeMozButton(isEditing ? "Cancel" : "Edit", "ghost", "small");
    editBtn.addEventListener("click", () => {
      if (editingPwId === pw.id) {
        cancelEditPw();
      } else {
        startEditPw(pw);
      }
    });
    actDiv.appendChild(editBtn);

    const accessBtn = makeMozButton("Access", "ghost", "small");
    accessBtn.addEventListener("click", () => openAccessDialog(pw));
    actDiv.appendChild(accessBtn);

    const deleteBtn = makeMozButton("Delete", "ghost", "small");
    deleteBtn.addEventListener("click", () => deletePw(pw.id));
    actDiv.appendChild(deleteBtn);
  }

  const fillBtn = makeMozButton("Fill", "ghost", "small");
  fillBtn.setAttribute("iconsrc", "chrome://browser/skin/login.svg");
  fillBtn.addEventListener("click", () => fillPassword(pw));
  actDiv.appendChild(fillBtn);

  actTd.appendChild(actDiv);
  tr.appendChild(actTd);
  tbody.appendChild(tr);

  if (isEditing) {
    const expandTr = document.createElement("tr");
    expandTr.className = "edit-expand-row";
    const expandTd = document.createElement("td");
    expandTd.colSpan = 4;

    const wrap = document.createElement("div");
    wrap.className = "perms-expand";

    const grid = document.createElement("div");
    grid.className = "pw-edit-grid";

    const fields = [
      { id: "epw-title", label: "Title", type: "text", value: pw.title },
      { id: "epw-url", label: "URL", type: "text", value: pw.url || "" },
      {
        id: "epw-username",
        label: "Username",
        type: "text",
        value: pw.username || "",
      },
      {
        id: "epw-value",
        label: "New password value (leave blank to keep current)",
        type: "password",
        value: "",
      },
    ];

    for (const f of fields) {
      const fieldDiv = document.createElement("div");
      fieldDiv.className = "form-field";
      const lbl = document.createElement("label");
      lbl.setAttribute("for", f.id);
      lbl.textContent = f.label;
      const inp = document.createElement("input");
      inp.id = f.id;
      inp.className = "vento-input";
      inp.type = f.type;
      inp.value = f.value;
      fieldDiv.appendChild(lbl);
      fieldDiv.appendChild(inp);
      grid.appendChild(fieldDiv);
    }
    wrap.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "perms-actions";
    const saveBtn = makeMozButton("Save", "primary", "small");
    saveBtn.addEventListener("click", () => submitEditPw(pw.id));
    const cancelBtn = makeMozButton("Cancel", "ghost", "small");
    cancelBtn.addEventListener("click", () => cancelEditPw());
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);

    expandTd.appendChild(wrap);
    expandTr.appendChild(expandTd);
    tbody.appendChild(expandTr);
  }
}

function openCreatePwForm() {
  $("cp-title").value = "";
  $("cp-url").value = "";
  $("cp-username").value = "";
  $("cp-value").value = "";
  $("create-pw-error").hidden = true;
  showCreatePwForm = true;
  editingPwId = null;
  renderPasswords();
}

async function submitCreatePw() {
  const title = $("cp-title").value.trim();
  const url = $("cp-url").value.trim();
  const username = $("cp-username").value.trim();
  const value = $("cp-value").value;
  const errorEl = $("create-pw-error");

  if (!title || !value) {
    errorEl.textContent = "Title and password value are required.";
    errorEl.hidden = false;
    return;
  }

  errorEl.hidden = true;
  createPwLoading = true;
  $("btn-create-pw").toggleAttribute("disabled", true);
  try {
    await api("/api/passwords", {
      method: "POST",
      body: { title, url, username, value },
    });
    showCreatePwForm = false;
    showStatus("Password entry created.");
    await loadPasswords(1);
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  } finally {
    createPwLoading = false;
    $("btn-create-pw").toggleAttribute("disabled", false);
    renderPasswords();
  }
}

function startEditPw(pw) {
  editingPwId = pw.id;
  showCreatePwForm = false;
  renderPasswords();
}

function cancelEditPw() {
  editingPwId = null;
  renderPasswords();
}

async function submitEditPw(id) {
  const body = {};
  const title = document.getElementById("epw-title")?.value;
  const url = document.getElementById("epw-url")?.value;
  const username = document.getElementById("epw-username")?.value;
  const value = document.getElementById("epw-value")?.value;
  if (title) {
    body.title = title;
  }
  if (url !== undefined) {
    body.url = url;
  }
  if (username !== undefined) {
    body.username = username;
  }
  if (value) {
    body.value = value;
  }
  try {
    await api(`/api/passwords/${id}`, { method: "PUT", body });
    editingPwId = null;
    showStatus("Password entry updated.");
    await loadPasswords(passwordsPage);
  } catch (e) {
    showStatus(e.message, "error");
  }
}

async function deletePw(id) {
  try {
    await api(`/api/passwords/${id}`, { method: "DELETE" });
    showStatus("Password entry deleted.");
    await loadPasswords(passwordsPage);
  } catch (e) {
    showStatus(e.message, "error");
  }
}

// ── Access dialog ─────────────────────────────────────────

async function openAccessDialog(pw) {
  accessPasswordId = pw.id;
  accessAllUsers = [];
  accessChecked = [];
  accessAllGroups = [];
  accessCheckedGroups = [];
  $("access-overlay").hidden = false;
  $("access-title").textContent = `Access \u2014 ${pw.title}`;
  $("access-filter").value = "";
  $("access-loading").hidden = false;
  clearChildren("access-user-list");
  accessLoading = true;
  try {
    const [accessData, usersData, groupsData] = await Promise.all([
      api(`/api/passwords/${pw.id}/access`),
      api(`/api/auth/users?page=1&per_page=500`),
      api(`/api/groups`),
    ]);
    accessChecked = accessData.user_ids ?? [];
    accessCheckedGroups = accessData.group_ids ?? [];
    accessAllUsers = usersData.users ?? [];
    accessAllGroups = groupsData.groups ?? [];
  } catch (e) {
    showStatus(e.message, "error");
    $("access-overlay").hidden = true;
    return;
  } finally {
    accessLoading = false;
    $("access-loading").hidden = true;
  }
  renderAccessUserList();
}

function accessTotalCount() {
  const ids = new Set(accessChecked);
  if (authUser?.user_id != null) {
    ids.add(authUser.user_id);
  }
  for (const gId of accessCheckedGroups) {
    for (const u of accessAllUsers) {
      if (u.groups?.some(g => g.id === gId)) {
        ids.add(u.id);
      }
    }
  }
  return ids.size;
}

function renderAccessUserList() {
  const total = accessTotalCount();
  const summaryEl = $("access-summary");
  if (total > 0) {
    summaryEl.textContent = `${total} ${total === 1 ? "user" : "users"} have access`;
    summaryEl.hidden = false;
  } else {
    summaryEl.hidden = true;
  }

  const q = $("access-filter").value.trim().toLowerCase();
  const filteredUsers = q
    ? accessAllUsers.filter(
        u =>
          u.display_name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
      )
    : accessAllUsers;
  const filteredGroups = q
    ? accessAllGroups.filter(g => g.name.toLowerCase().includes(q))
    : accessAllGroups;

  const listEl = $("access-user-list");
  clearChildren(listEl);

  if (!filteredUsers.length && !filteredGroups.length) {
    const p = document.createElement("p");
    p.style.cssText =
      "color:var(--text-color-deemphasized,gray);font-size:13px;margin:8px 0";
    p.textContent = "No results found.";
    listEl.appendChild(p);
    return;
  }

  if (filteredGroups.length) {
    const heading = document.createElement("div");
    heading.className = "access-section-heading";
    heading.textContent = "Groups";
    listEl.appendChild(heading);

    for (const g of filteredGroups) {
      const lbl = document.createElement("label");
      lbl.className = "access-user-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = accessCheckedGroups.includes(g.id);
      cb.addEventListener("change", () => {
        if (accessCheckedGroups.includes(g.id)) {
          accessCheckedGroups = accessCheckedGroups.filter(id => id !== g.id);
          const groupUserIds = new Set(
            accessAllUsers
              .filter(u => u.groups?.some(ug => ug.id === g.id))
              .map(u => u.id)
          );
          accessChecked = accessChecked.filter(id => !groupUserIds.has(id));
        } else {
          accessCheckedGroups = [...accessCheckedGroups, g.id];
          for (const u of accessAllUsers) {
            if (u.groups?.some(ug => ug.id === g.id) && !accessChecked.includes(u.id)) {
              accessChecked = [...accessChecked, u.id];
            }
          }
        }
        renderAccessUserList();
      });
      const nameSpan = document.createElement("span");
      nameSpan.className = "access-user-name";
      nameSpan.textContent = g.name;
      const countSpan = document.createElement("span");
      countSpan.className = "access-user-email";
      countSpan.textContent = `${g.member_count} ${g.member_count === 1 ? "member" : "members"}`;
      lbl.appendChild(cb);
      lbl.appendChild(nameSpan);
      lbl.appendChild(countSpan);
      listEl.appendChild(lbl);
    }
  }

  if (filteredUsers.length) {
    const heading = document.createElement("div");
    heading.className = "access-section-heading";
    heading.textContent = "Users";
    listEl.appendChild(heading);

    for (const u of filteredUsers) {
      const isSelf = u.id === authUser?.user_id;
      const lbl = document.createElement("label");
      lbl.className = "access-user-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isSelf || accessChecked.includes(u.id);
      if (isSelf) {
        cb.disabled = true;
      }
      cb.addEventListener("change", () => {
        if (accessChecked.includes(u.id)) {
          accessChecked = accessChecked.filter(id => id !== u.id);
          accessCheckedGroups = accessCheckedGroups.filter(
            gId => !u.groups?.some(g => g.id === gId)
          );
        } else {
          accessChecked = [...accessChecked, u.id];
        }
        renderAccessUserList();
      });
      const nameSpan = document.createElement("span");
      nameSpan.className = "access-user-name";
      nameSpan.textContent = u.display_name;
      const emailSpan = document.createElement("span");
      emailSpan.className = "access-user-email";
      emailSpan.textContent = u.email;
      lbl.appendChild(cb);
      lbl.appendChild(nameSpan);
      lbl.appendChild(emailSpan);
      listEl.appendChild(lbl);
    }
  }
}

function closeAccessDialog() {
  $("access-overlay").hidden = true;
  accessPasswordId = null;
}

async function savePasswordAccess() {
  $("btn-save-access").toggleAttribute("disabled", true);
  try {
    await api(`/api/passwords/${accessPasswordId}/access`, {
      method: "PUT",
      body: { user_ids: accessChecked, group_ids: accessCheckedGroups },
    });
    $("access-overlay").hidden = true;
    showStatus("Access list saved.");
  } catch (e) {
    showStatus(e.message, "error");
  } finally {
    $("btn-save-access").toggleAttribute("disabled", false);
  }
}

// ── Profile ───────────────────────────────────────────────

function renderProfile() {
  const u = authUser;
  if (!u) {
    return;
  }
  $("profile-name").textContent = u.display_name;
  $("profile-email").textContent = u.email;
  const permsEl = $("profile-perms");
  clearChildren(permsEl);
  if (u.permissions.length) {
    for (const p of u.permissions) {
      permsEl.appendChild(makeBadge(p, "badge-perm"));
    }
  } else {
    const dash = document.createElement("span");
    dash.style.color = "var(--text-color-deemphasized,gray)";
    dash.textContent = "\u2014";
    permsEl.appendChild(dash);
  }
}

// ── Fill password ─────────────────────────────────────────

async function fillPassword(pw) {
  const win = Services.wm.getMostRecentBrowserWindow();
  if (!win?.gBrowser) {
    showStatus("No browser window found.", "error");
    return;
  }
  const { gBrowser } = win;

  let pwHostname = "";
  if (pw.url) {
    try {
      const href = /^https?:\/\//i.test(pw.url) ? pw.url : `https://${pw.url}`;
      pwHostname = new URL(href).hostname.toLowerCase();
    } catch {
      // not a parseable URL
    }
  }

  const candidates = Array.from(gBrowser.tabs).filter(
    t => !t.closing && t.linkedBrowser?.currentURI?.spec !== "about:vento"
  );

  candidates.sort((a, b) => {
    const hostnameOf = tab => {
      try {
        return new URL(
          tab.linkedBrowser.currentURI.spec
        ).hostname.toLowerCase();
      } catch {
        return "";
      }
    };
    const aMatch = pwHostname && hostnameOf(a) === pwHostname ? 1 : 0;
    const bMatch = pwHostname && hostnameOf(b) === pwHostname ? 1 : 0;
    if (bMatch !== aMatch) {
      return bMatch - aMatch;
    }
    return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
  });

  if (!candidates.length) {
    showStatus("No other tab found to fill into.", "error");
    return;
  }

  const targetTab = candidates[0];
  const bc = targetTab.linkedBrowser?.browsingContext;
  if (!bc?.currentWindowGlobal) {
    showStatus("Target tab is not ready.", "error");
    return;
  }

  try {
    const actor = bc.currentWindowGlobal.getActor("VentoPassword");
    const result = await actor.directFill({
      credentialId: pw.id,
      username: pw.username,
      credentialTitle: pw.title,
      apiBase: apiBase(),
      bearerToken: token(),
    });
    if (result?.filled) {
      showStatus("Password filled.");
      gBrowser.selectedTab = targetTab;
    } else {
      showStatus(
        `Could not fill: ${result?.reason ?? "no password field found"}`,
        "error"
      );
    }
  } catch (e) {
    showStatus(`Fill failed: ${e.message}`, "error");
  }
}

// ── Init ──────────────────────────────────────────────────

async function init() {
  for (const btn of document.querySelectorAll("#categories .category")) {
    btn.addEventListener("click", () => navigate(btn.getAttribute("name")));
  }

  // Dashboard
  $("btn-refresh").addEventListener("click", () => loadDashboard());

  // Users
  $("btn-new-user").addEventListener("click", () => openCreateForm());
  $("btn-cancel-create-user").addEventListener("click", () => {
    showCreateForm = false;
    renderUsers();
  });
  $("btn-gen-password").addEventListener("click", () => generatePassword());
  $("btn-copy-password").addEventListener("click", () => copyPassword());
  $("btn-create-user").addEventListener("click", () => submitCreateUser());
  $("users-prev").addEventListener("click", () => loadUsers(usersPage - 1));
  $("users-next").addEventListener("click", () => loadUsers(usersPage + 1));

  // Groups
  $("btn-new-group").addEventListener("click", () => openCreateGroupForm());
  $("btn-cancel-create-group").addEventListener("click", () => {
    showCreateGroupForm = false;
    renderGroups();
  });
  $("btn-create-group").addEventListener("click", () => submitCreateGroup());

  // Group members dialog
  $("members-filter").addEventListener("input", () => renderMembersUserList());
  $("members-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) {
      closeMembersDialog();
    }
  });
  $("btn-save-members").addEventListener("click", () => saveGroupMembers());
  $("btn-cancel-members").addEventListener("click", () => closeMembersDialog());

  // Passwords
  $("btn-new-pw").addEventListener("click", () => openCreatePwForm());
  $("btn-cancel-create-pw").addEventListener("click", () => {
    showCreatePwForm = false;
    renderPasswords();
  });
  $("btn-create-pw").addEventListener("click", () => submitCreatePw());
  $("pw-prev").addEventListener("click", () => loadPasswords(passwordsPage - 1));
  $("pw-next").addEventListener("click", () => loadPasswords(passwordsPage + 1));

  // Access dialog
  $("access-filter").addEventListener("input", () => renderAccessUserList());
  $("access-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) {
      closeAccessDialog();
    }
  });
  $("btn-save-access").addEventListener("click", () => savePasswordAccess());
  $("btn-cancel-access").addEventListener("click", () => closeAccessDialog());

  // Profile
  $("btn-logout").addEventListener("click", () => logout());

  window.addEventListener("unload", () => disconnectWs());

  await loadCurrentUser();
  renderApp();

  if (authUser) {
    navigate("dashboard");
    connectWs();
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
