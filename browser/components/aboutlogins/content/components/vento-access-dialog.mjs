/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export default class VentoAccessDialog extends HTMLElement {
  #guid = null;
  #allUsers = [];
  #allGroups = [];
  #userShares = [];
  #groupShares = [];
  #searchFilter = "";

  connectedCallback() {
    if (this.shadowRoot) {
      return;
    }
    let template = document.querySelector("#vento-access-dialog-template");
    let shadowRoot = this.attachShadow({ mode: "open" });
    shadowRoot.appendChild(template.content.cloneNode(true));

    this.#el(".dismiss-button").addEventListener("click", () => this.close());
    this.#el(".cancel-button").addEventListener("click", () => this.close());
    this.#el(".save-button").addEventListener("click", () => this.#save());
    this.#el(".access-search").addEventListener("input", e => {
      this.#searchFilter = e.target.value;
      this.#renderList();
    });
    this.#el(".overlay").addEventListener("click", e => {
      if (e.target === e.currentTarget) {
        this.close();
      }
    });

    window.addEventListener("AboutLoginsChromeToContent", e => {
      const { messageType, value } = e.detail;
      if (messageType === "VentoAccess" && value.guid === this.#guid) {
        this.#onAccessLoaded(value);
      }
      if (messageType === "VentoAccessSaved" && value.guid === this.#guid) {
        if (!value.error) {
          this.close();
        } else {
          this.#el(".access-error").textContent = value.error;
          this.#el(".access-error").hidden = false;
        }
      }
    });
  }

  #el(selector) {
    return this.shadowRoot.querySelector(selector);
  }

  show(guid) {
    this.#guid = guid;
    this.#allUsers = [];
    this.#allGroups = [];
    this.#userShares = [];
    this.#groupShares = [];
    this.#searchFilter = "";
    this.#el(".access-search").value = "";
    this.#el(".access-error").hidden = true;
    const list = this.#el(".access-list");
    list.innerHTML = "";
    const loading = document.createElement("span");
    loading.textContent = "Loading...";
    list.appendChild(loading);
    this.removeAttribute("hidden");

    document.dispatchEvent(
      new CustomEvent("AboutLoginsVentoGetAccess", {
        bubbles: true,
        detail: { guid },
      })
    );
  }

  close() {
    this.setAttribute("hidden", "");
    this.#guid = null;
  }

  #onAccessLoaded({ access, users, groups, error }) {
    if (error) {
      this.#el(".access-error").textContent = error;
      this.#el(".access-error").hidden = false;
      this.#el(".access-list").innerHTML = "";
      return;
    }
    this.#userShares = (access.user_shares || []).map(s => ({ ...s }));
    this.#groupShares = (access.group_shares || []).map(s => ({ ...s }));
    this.#allUsers = users || [];
    this.#allGroups = groups || [];
    this.#renderList();
  }

  #renderList() {
    const list = this.#el(".access-list");
    list.innerHTML = "";
    const q = this.#searchFilter.toLowerCase();

    const filteredGroups = this.#allGroups.filter(
      g => !q || g.name.toLowerCase().includes(q)
    );
    const filteredUsers = this.#allUsers.filter(
      u =>
        !q ||
        u.display_name.toLowerCase().includes(q) ||
        (u.email || "").toLowerCase().includes(q)
    );

    if (filteredGroups.length) {
      const heading = document.createElement("div");
      heading.className = "section-heading";
      heading.textContent = "Groups";
      list.appendChild(heading);
      for (const g of filteredGroups) {
        list.appendChild(this.#makeGroupRow(g));
      }
    }

    if (filteredUsers.length) {
      const heading = document.createElement("div");
      heading.className = "section-heading";
      heading.textContent = "Users";
      list.appendChild(heading);
      for (const u of filteredUsers) {
        list.appendChild(this.#makeUserRow(u));
      }
    }

    if (!filteredGroups.length && !filteredUsers.length) {
      const empty = document.createElement("span");
      empty.textContent = "No results";
      list.appendChild(empty);
    }
  }

  #makeUserRow(user) {
    const share = this.#userShares.find(s => s.user_id === user.id);
    const isShared = !!share;

    const row = document.createElement("div");
    row.className = "access-row";

    const sharedCheck = document.createElement("input");
    sharedCheck.type = "checkbox";
    sharedCheck.checked = isShared;
    sharedCheck.title = "Shared";

    const nameCell = document.createElement("div");
    nameCell.className = "access-name";
    nameCell.textContent = user.display_name;
    const sub = document.createElement("span");
    sub.className = "access-sub";
    sub.textContent = user.email || "";
    nameCell.appendChild(sub);

    const hiddenLabel = document.createElement("label");
    hiddenLabel.className = "access-check-label";
    const hiddenCheck = document.createElement("input");
    hiddenCheck.type = "checkbox";
    hiddenCheck.checked = !!share?.is_hidden;
    hiddenCheck.disabled = !isShared;
    hiddenLabel.appendChild(hiddenCheck);
    hiddenLabel.append(" Hidden");

    const updateLabel = document.createElement("label");
    updateLabel.className = "access-check-label";
    const updateCheck = document.createElement("input");
    updateCheck.type = "checkbox";
    updateCheck.checked = !!share?.can_update;
    updateCheck.disabled = !isShared;
    updateLabel.appendChild(updateCheck);
    updateLabel.append(" Can update");

    sharedCheck.addEventListener("change", () => {
      if (sharedCheck.checked) {
        this.#userShares.push({
          user_id: user.id,
          is_hidden: false,
          can_update: false,
        });
      } else {
        this.#userShares = this.#userShares.filter(s => s.user_id !== user.id);
      }
      hiddenCheck.disabled = !sharedCheck.checked;
      updateCheck.disabled = !sharedCheck.checked;
    });
    hiddenCheck.addEventListener("change", () => {
      const s = this.#userShares.find(x => x.user_id === user.id);
      if (s) {
        s.is_hidden = hiddenCheck.checked;
      }
    });
    updateCheck.addEventListener("change", () => {
      const s = this.#userShares.find(x => x.user_id === user.id);
      if (s) {
        s.can_update = updateCheck.checked;
      }
    });

    row.appendChild(sharedCheck);
    row.appendChild(nameCell);
    row.appendChild(hiddenLabel);
    row.appendChild(updateLabel);
    return row;
  }

  #makeGroupRow(group) {
    const share = this.#groupShares.find(s => s.group_id === group.id);
    const isShared = !!share;

    const row = document.createElement("div");
    row.className = "access-row";

    const sharedCheck = document.createElement("input");
    sharedCheck.type = "checkbox";
    sharedCheck.checked = isShared;
    sharedCheck.title = "Shared";

    const nameCell = document.createElement("div");
    nameCell.className = "access-name";
    nameCell.textContent = group.name;
    const sub = document.createElement("span");
    sub.className = "access-sub";
    sub.textContent = `${group.member_count ?? 0} members`;
    nameCell.appendChild(sub);

    const hiddenLabel = document.createElement("label");
    hiddenLabel.className = "access-check-label";
    const hiddenCheck = document.createElement("input");
    hiddenCheck.type = "checkbox";
    hiddenCheck.checked = !!share?.is_hidden;
    hiddenCheck.disabled = !isShared;
    hiddenLabel.appendChild(hiddenCheck);
    hiddenLabel.append(" Hidden");

    const updateLabel = document.createElement("label");
    updateLabel.className = "access-check-label";
    const updateCheck = document.createElement("input");
    updateCheck.type = "checkbox";
    updateCheck.checked = !!share?.can_update;
    updateCheck.disabled = !isShared;
    updateLabel.appendChild(updateCheck);
    updateLabel.append(" Can update");

    sharedCheck.addEventListener("change", () => {
      if (sharedCheck.checked) {
        this.#groupShares.push({
          group_id: group.id,
          is_hidden: false,
          can_update: false,
        });
      } else {
        this.#groupShares = this.#groupShares.filter(
          s => s.group_id !== group.id
        );
      }
      hiddenCheck.disabled = !sharedCheck.checked;
      updateCheck.disabled = !sharedCheck.checked;
    });
    hiddenCheck.addEventListener("change", () => {
      const s = this.#groupShares.find(x => x.group_id === group.id);
      if (s) {
        s.is_hidden = hiddenCheck.checked;
      }
    });
    updateCheck.addEventListener("change", () => {
      const s = this.#groupShares.find(x => x.group_id === group.id);
      if (s) {
        s.can_update = updateCheck.checked;
      }
    });

    row.appendChild(sharedCheck);
    row.appendChild(nameCell);
    row.appendChild(hiddenLabel);
    row.appendChild(updateLabel);
    return row;
  }

  #save() {
    this.#el(".access-error").hidden = true;
    document.dispatchEvent(
      new CustomEvent("AboutLoginsVentoSetAccess", {
        bubbles: true,
        detail: {
          guid: this.#guid,
          userShares: this.#userShares,
          groupShares: this.#groupShares,
        },
      })
    );
  }
}
customElements.define("vento-access-dialog", VentoAccessDialog);
