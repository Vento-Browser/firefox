/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  QR: "moz-src:///toolkit/components/qrcode/encoder.mjs",
});

const state = {
  server: "",
  email: "",
  password: "",
  setupToken: "",
  passwordChangeToken: "",
  connected: false,
};

async function apiFetch(method, path, body, token) {
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${state.server}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

function showView(id) {
  document.querySelectorAll(".view").forEach(v => {
    v.hidden = true;
  });
  document.getElementById(id).hidden = false;
}

function showError(id, message) {
  const el = document.getElementById(id);
  el.className = "error";
  el.textContent = message;
  el.hidden = false;
}

function showSuccess(id, message) {
  const el = document.getElementById(id);
  el.className = "success";
  el.textContent = message;
  el.hidden = false;
}

function clearMessage(id) {
  document.getElementById(id).hidden = true;
}

function setLoading(form, loading) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = loading;
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.textContent = "Please wait\u2026";
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

function onSuccess(accessToken) {
  Services.prefs.setStringPref("browser.logingate.serverUrl", state.server);
  Services.prefs.setStringPref("browser.logingate.accessToken", accessToken);
  state.connected = true;
  window.close();
}

document.getElementById("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  clearMessage("login-error");

  const serverRaw = document
    .getElementById("server")
    .value.trim()
    .replace(/\/+$/, "");
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!serverRaw || !email || !password) {
    showError("login-error", "All fields are required.");
    return;
  }

  const isLocal = /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(
    serverRaw.split("/")[0]
  );
  state.server = /^https?:\/\//i.test(serverRaw)
    ? serverRaw
    : `${isLocal ? "http" : "https"}://${serverRaw}`;
  state.email = email;
  state.password = password;

  setLoading(e.target, true);
  try {
    const { ok, status, data } = await apiFetch("POST", "/api/auth/login", {
      email,
      password,
    });

    if (data.totp_setup_required) {
      state.setupToken = data.setup_token;

      try {
        const settingsRes = await apiFetch("GET", "/api/settings");
        const clientDisplayName =
          settingsRes.ok && settingsRes.data.client_display_name;
        if (clientDisplayName) {
          document.getElementById("totp-setup-description").textContent =
            `Scan the QR code below to add ${clientDisplayName} to your authenticator app, then enter the generated code.`;
        }
      } catch {}

      const otpauthUrl = data.otpauth_url ?? "";
      try {
        const qrData = lazy.QR.encodeToDataURI(otpauthUrl, "M");
        const qrImg = document.getElementById("totp-qr-code");
        qrImg.src = qrData.src;
      } catch {}

      try {
        const url = new URL(otpauthUrl);
        document.getElementById("totp-secret").textContent =
          url.searchParams.get("secret") ?? "";
      } catch {
        document.getElementById("totp-secret").textContent = "";
      }
      document.getElementById("totp-url").value = otpauthUrl;
      showView("view-totp-setup");
      document.getElementById("totp-setup-code").focus();
      return;
    }

    if (data.password_change_required) {
      state.passwordChangeToken = data.password_change_token;
      showView("view-password-change");
      document.getElementById("new-password").focus();
      return;
    }

    if (data.access_token) {
      onSuccess(data.access_token);
      return;
    }

    if (!ok) {
      const msg = data.error ?? "Authentication failed.";
      if (status === 401 && msg.toLowerCase().includes("totp")) {
        showView("view-totp-verify");
        document.getElementById("totp-verify-code").focus();
        return;
      }
      showError("login-error", msg);
    }
  } catch (err) {
    showError("login-error", `Cannot connect to server: ${err.message}`);
  } finally {
    setLoading(e.target, false);
  }
});

document.getElementById("totpSetupForm").addEventListener("submit", async e => {
  e.preventDefault();
  clearMessage("totp-setup-error");

  const totpCode = document.getElementById("totp-setup-code").value.trim();
  setLoading(e.target, true);
  try {
    const { ok, data } = await apiFetch(
      "POST",
      "/api/auth/totp/setup/complete",
      { setup_token: state.setupToken, totp_code: totpCode }
    );
    if (ok && data.access_token) {
      onSuccess(data.access_token);
      return;
    }
    showError(
      "totp-setup-error",
      data.error ?? "Invalid code. Please try again."
    );
  } catch (err) {
    showError("totp-setup-error", `Error: ${err.message}`);
  } finally {
    setLoading(e.target, false);
  }
});

document
  .getElementById("totpVerifyForm")
  .addEventListener("submit", async e => {
    e.preventDefault();
    clearMessage("totp-verify-error");

    const totpCode = document.getElementById("totp-verify-code").value.trim();
    setLoading(e.target, true);
    try {
      const { ok, data } = await apiFetch("POST", "/api/auth/login", {
        email: state.email,
        password: state.password,
        totp_code: totpCode,
      });
      if (ok && data.access_token) {
        onSuccess(data.access_token);
        return;
      }
      showError(
        "totp-verify-error",
        data.error ?? "Invalid code. Please try again."
      );
    } catch (err) {
      showError("totp-verify-error", `Error: ${err.message}`);
    } finally {
      setLoading(e.target, false);
    }
  });

document
  .getElementById("passwordChangeForm")
  .addEventListener("submit", async e => {
    e.preventDefault();
    clearMessage("password-change-error");

    const newPassword = document.getElementById("new-password").value;
    const confirmPassword = document.getElementById("confirm-password").value;

    if (newPassword !== confirmPassword) {
      showError("password-change-error", "Passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      showError(
        "password-change-error",
        "Password must be at least 8 characters."
      );
      return;
    }

    setLoading(e.target, true);
    try {
      const { ok, data } = await apiFetch(
        "PUT",
        "/api/auth/password/forced",
        { new_password: newPassword },
        state.passwordChangeToken
      );
      if (ok) {
        showView("view-login");
        showSuccess(
          "login-error",
          "Password changed. Please log in with your new password."
        );
        return;
      }
      showError(
        "password-change-error",
        data.error ?? "Failed to change password."
      );
    } catch (err) {
      showError("password-change-error", `Error: ${err.message}`);
    } finally {
      setLoading(e.target, false);
    }
  });

async function checkExistingSession() {
  let token, serverUrl;
  try {
    token = Services.prefs.getStringPref("browser.logingate.accessToken", "");
    serverUrl = Services.prefs.getStringPref(
      "browser.logingate.serverUrl",
      ""
    );
  } catch {
    return;
  }

  if (!token || !serverUrl) {
    return;
  }

  state.server = serverUrl;

  try {
    const { ok, data } = await apiFetch(
      "GET",
      "/api/auth/validate",
      undefined,
      token
    );
    if (!ok) {
      return;
    }

    document.getElementById("profile-server").textContent = serverUrl;
    document.getElementById("profile-display-name").textContent =
      data.display_name ?? data.email ?? "";
    document.getElementById("profile-email").textContent = data.email ?? "";

    // const perms = data.permissions ?? [];
    // if (perms.length > 0) {
    //   document.getElementById("profile-permissions").textContent =
    //     perms.join(", ");
    // } else {
    //   document.getElementById("profile-permissions-block").hidden = true;
    // }

    state.connected = true;
    showView("view-profile");
  } catch {
    // Token invalid or server unreachable — show login form as usual.
  }
}

document.getElementById("continue-btn").addEventListener("click", () => {
  window.close();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  Services.prefs.clearUserPref("browser.logingate.accessToken");
  Services.prefs.clearUserPref("browser.logingate.serverUrl");
  state.server = "";
  showView("view-login");
});

checkExistingSession();

window.addEventListener("unload", () => {
  if (!state.connected) {
    const isReauth = Services.prefs.getBoolPref(
      "browser.logingate.reauth",
      false
    );
    if (!isReauth) {
      Services.startup.quit(Services.startup.eAttemptQuit);
    }
  }
});
