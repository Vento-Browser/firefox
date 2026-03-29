/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export default class VentoHistoryDialog extends HTMLElement {
  #guid = null;

  connectedCallback() {
    if (this.shadowRoot) {
      return;
    }
    let template = document.querySelector("#vento-history-dialog-template");
    let shadowRoot = this.attachShadow({ mode: "open" });
    shadowRoot.appendChild(template.content.cloneNode(true));

    this.#el(".dismiss-button").addEventListener("click", () => this.close());
    this.#el(".close-button").addEventListener("click", () => this.close());
    this.#el(".overlay").addEventListener("click", e => {
      if (e.target === e.currentTarget) {
        this.close();
      }
    });

    window.addEventListener("AboutLoginsChromeToContent", e => {
      const { messageType, value } = e.detail;
      if (messageType === "VentoHistory" && value.guid === this.#guid) {
        this.#renderHistory(value);
      }
      if (messageType === "VentoRollbackDone" && value.guid === this.#guid) {
        if (!value.error) {
          document.dispatchEvent(
            new CustomEvent("AboutLoginsVentoGetHistory", {
              bubbles: true,
              detail: { guid: this.#guid },
            })
          );
        } else {
          this.#el(".history-error").textContent = value.error;
          this.#el(".history-error").hidden = false;
        }
      }
    });
  }

  #el(selector) {
    return this.shadowRoot.querySelector(selector);
  }

  show(guid) {
    this.#guid = guid;
    this.#el(".history-error").hidden = true;
    const list = this.#el(".history-list");
    list.innerHTML = "";
    const loading = document.createElement("span");
    loading.textContent = "Loading...";
    list.appendChild(loading);
    this.removeAttribute("hidden");

    document.dispatchEvent(
      new CustomEvent("AboutLoginsVentoGetHistory", {
        bubbles: true,
        detail: { guid },
      })
    );
  }

  close() {
    this.setAttribute("hidden", "");
    this.#guid = null;
  }

  #renderHistory({ history: historyData, error }) {
    const list = this.#el(".history-list");
    list.innerHTML = "";

    if (error) {
      const msg = document.createElement("span");
      msg.textContent = error;
      list.appendChild(msg);
      return;
    }

    const { entries = [], can_rollback_last = false } = historyData || {};

    if (!entries.length) {
      const msg = document.createElement("span");
      msg.textContent = "No history available.";
      list.appendChild(msg);
      return;
    }

    entries.forEach((entry, idx) => {
      const row = document.createElement("div");
      row.className = "history-row";

      const actionSpan = document.createElement("span");
      actionSpan.className = "history-action";
      actionSpan.textContent = entry.action;

      const userSpan = document.createElement("span");
      userSpan.className = "history-user";
      userSpan.textContent = entry.user_display_name || "";

      const dateSpan = document.createElement("span");
      dateSpan.className = "history-date";
      try {
        dateSpan.textContent = new Date(entry.created_at).toLocaleString();
      } catch {
        dateSpan.textContent = entry.created_at || "";
      }

      row.appendChild(actionSpan);
      row.appendChild(userSpan);
      row.appendChild(dateSpan);

      if (idx === 0 && can_rollback_last) {
        const btn = document.createElement("button");
        btn.className = "rollback-button";
        btn.textContent = "Rollback";
        btn.addEventListener("click", () => {
          this.#el(".history-error").hidden = true;
          document.dispatchEvent(
            new CustomEvent("AboutLoginsVentoRollback", {
              bubbles: true,
              detail: { guid: this.#guid, historyId: entry.id },
            })
          );
        });
        row.appendChild(btn);
      }

      list.appendChild(row);
    });
  }
}
customElements.define("vento-history-dialog", VentoHistoryDialog);
