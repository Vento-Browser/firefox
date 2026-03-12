/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActorChild — runs in the content process.
 *
 * Receives "VentoPassword:DirectFill" from VentoPasswordParent and fills the
 * first visible password field on the page with the real password value,
 * showing a credential chip in place of the password dots.
 */
export class VentoPasswordChild extends JSWindowActorChild {
  receiveMessage(msg) {
    if (msg.name === "VentoPassword:DirectFill") {
      return this.#handleFill(msg.data);
    }
    return null;
  }

  #handleFill({ username, fillToken, credentialTitle }) {
    const doc = this.contentWindow?.document;
    if (!doc) {
      return { filled: false, reason: "no-document" };
    }

    // Collect all visible, enabled password inputs.
    const pwInputs = Array.from(
      doc.querySelectorAll("input[type=password]")
    ).filter(el => !el.disabled && !el.readOnly && this.#isVisible(el));

    if (!pwInputs.length) {
      return { filled: false, reason: "no-password-field" };
    }

    const pwInput = pwInputs[0];

    // Fill username into the last visible text/email input that precedes
    // the password field within the same form (or anywhere on the page).
    if (username) {
      const scope = pwInput.closest("form") ?? doc;
      const textInputs = Array.from(
        scope.querySelectorAll(
          "input[type=text], input[type=email], input[type=tel], input:not([type])"
        )
      ).filter(el => !el.disabled && !el.readOnly && this.#isVisible(el));

      if (textInputs.length) {
        textInputs[textInputs.length - 1].setUserInput(username);
      }
    }

    // Fill the password field with the opaque fill token.
    // setUserInput() requires system principal (privileged actor code) and
    // bypasses normal JS setter chains, dispatching proper input/change events
    // so the page's form logic is not broken.
    pwInput.setUserInput(fillToken);
    pwInput.focus();

    // Show a credential chip so the user sees the credential name
    // rather than a row of bullet dots.
    if (credentialTitle) {
      this.#injectChip(pwInput, credentialTitle);
    }

    return { filled: true };
  }

  /**
   * Replace the password input visually with a styled rectangular container
   * that holds a credential chip.  The real <input> stays in the DOM (holding
   * the fill token) so form submission still works, but is hidden from view.
   *
   * Because the container is a normal DOM element (not inserted into the
   * native-anonymous subtree), the ✕ clear button receives pointer events
   * directly with no hit-testing workarounds.
   *
   * Layout: [🔒 credential title  ✕]  inside a div that matches the
   * input's bounding rect, styled to look like a filled input field.
   */
  #injectChip(input, title) {
    const doc = input.ownerDocument;
    const win = doc.defaultView;

    // Remove any leftover container from a previous fill on this page.
    doc.querySelector(".__vento_chip__")?.remove();

    // ── Determine positioning strategy ─────────────────────────────────────
    // Prefer position:absolute inside the input's offsetParent.  The container
    // then lives in the same stacking context as the form, so it inherits all
    // CSS visibility changes (opacity transitions, display:none, etc.) without
    // any MutationObserver or scroll tracking — it hides/shows with the form
    // automatically.
    //
    // Fall back to position:fixed (appended to <html>) only when offsetParent
    // is null (e.g. the input itself is position:fixed).
    const posParent = input.offsetParent;
    const useFixed = !posParent;

    // ── Save & hide the real input ─────────────────────────────────────────
    // Save entire attribute strings so we can restore them atom-for-atom.
    const prevStyleAttr = input.getAttribute("style");   // null = no attr
    const prevReadonly  = input.hasAttribute("readonly"); // false (we filter !readOnly)
    const prevTabindex  = input.getAttribute("tabindex"); // null = no attr
    const wasDisabled   = input.disabled;

    input.setAttribute("readonly", "");
    input.setAttribute("tabindex", "-1");
    // Append our hiding styles after any pre-existing inline styles.
    const hidingStyles = "opacity: 0; pointer-events: none; user-select: none;";
    input.setAttribute(
      "style",
      prevStyleAttr ? prevStyleAttr + "; " + hidingStyles : hidingStyles
    );

    // Prevent clipboard access to the fill value while the chip is visible.
    const preventCopy = e => e.preventDefault();
    input.addEventListener("copy", preventCopy, { capture: true });
    input.addEventListener("cut", preventCopy, { capture: true });

    // ── Build the chip pill ────────────────────────────────────────────────
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "flex-shrink:0;opacity:.75;pointer-events:none";
    const lockPath = doc.createElementNS(svgNS, "path");
    lockPath.setAttribute(
      "d",
      "M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 " +
        "2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 " +
        "3.1 0 0 1 6.2 0v2z"
    );
    svg.appendChild(lockPath);

    const label = doc.createElement("span");
    label.textContent = title;
    label.style.cssText =
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "max-width:180px;pointer-events:none";

    const clearBtn = doc.createElement("button");
    clearBtn.setAttribute("type", "button");
    clearBtn.setAttribute("aria-label", "Clear autofill");
    clearBtn.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: color-mix(in srgb, AccentColor 22%, Canvas);
      cursor: pointer;
      flex-shrink: 0;
      font: 700 10px/1 system-ui, sans-serif;
      color: AccentColor;
      margin-inline-start: 2px;
    `;
    clearBtn.textContent = "✕";

    const chip = doc.createElement("div");
    chip.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 0 6px 0 8px;
      height: 24px;
      background: color-mix(in srgb, AccentColor 12%, Canvas);
      color: AccentColor;
      border-radius: 12px;
      font: 500 12px/1 system-ui, sans-serif;
      white-space: nowrap;
      max-width: 100%;
      box-sizing: border-box;
    `;
    chip.append(svg, label, clearBtn);

    // ── Build the input-shaped container ───────────────────────────────────
    const cs = win.getComputedStyle(input);

    const container = doc.createElement("div");
    container.className = "__vento_chip__";
    container.appendChild(chip);

    const sharedStyle = `
      box-sizing: border-box;
      display: flex;
      align-items: center;
      padding: 0 8px;
      background: ${cs.backgroundColor || "Canvas"};
      border: ${cs.border || "1px solid color-mix(in srgb, CanvasText 25%, Canvas)"};
      border-radius: ${cs.borderRadius || "4px"};
      font: ${cs.font || "14px system-ui, sans-serif"};
      color-scheme: ${cs.colorScheme || "light dark"};
      z-index: 2147483647;
      user-select: none;
      overflow: hidden;
    `;

    // Scroll/resize sync is only needed for the position:fixed fallback.
    let syncFixed = null;

    if (!useFixed) {
      // ── Absolute positioning inside offsetParent ──────────────────────────
      // The container lives inside the form's stacking context, so it
      // inherits opacity, visibility, display changes automatically.
      container.style.cssText = `
        position: absolute;
        left: ${input.offsetLeft}px;
        top: ${input.offsetTop}px;
        width: ${input.offsetWidth}px;
        height: ${input.offsetHeight}px;
        ${sharedStyle}
      `;
      posParent.appendChild(container);
    } else {
      // ── Fixed positioning fallback (input is position:fixed) ──────────────
      const r = input.getBoundingClientRect();
      container.style.cssText = `
        position: fixed;
        left: ${r.left}px;
        top: ${r.top}px;
        width: ${r.width}px;
        height: ${r.height}px;
        ${sharedStyle}
      `;
      doc.documentElement.appendChild(container);

      syncFixed = () => {
        if (!input.isConnected || !this.#isVisible(input)) {
          cleanup();
          return;
        }
        const nr = input.getBoundingClientRect();
        container.style.left = `${nr.left}px`;
        container.style.top = `${nr.top}px`;
        container.style.width = `${nr.width}px`;
        container.style.height = `${nr.height}px`;
        const inViewport =
          nr.bottom > 0 &&
          nr.top < win.innerHeight &&
          nr.right > 0 &&
          nr.left < win.innerWidth;
        container.style.visibility = inViewport ? "visible" : "hidden";
      };
      doc.addEventListener("scroll", syncFixed, { capture: true, passive: true });
      win.addEventListener("resize", syncFixed, { passive: true });
    }

    // ── Cleanup ────────────────────────────────────────────────────────────
    // Use a flag instead of container.isConnected because in the absolute
    // case the container is removed along with the form — isConnected would
    // already be false before cleanup() is ever called explicitly.
    let cleanedUp = false;
    const cleanup = (clearValue = false) => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      // Restore the style attribute atom-for-atom.
      if (prevStyleAttr === null) {
        input.removeAttribute("style");
      } else {
        input.setAttribute("style", prevStyleAttr);
      }
      // Restore readonly.
      if (prevReadonly) {
        input.setAttribute("readonly", "");
      } else {
        input.removeAttribute("readonly");
      }
      // Restore tabindex.
      if (prevTabindex === null) {
        input.removeAttribute("tabindex");
      } else {
        input.setAttribute("tabindex", prevTabindex);
      }
      // Also undo any side-effect page JS may have applied (e.g. setting
      // disabled=true in response to our readonly attribute change).
      input.disabled = wasDisabled;
      if (input.isConnected && clearValue) {
        // setUserInput dispatches input/change events so frameworks (React,
        // Vue, etc.) that stored the fill token via onChange can sync their
        // state back to an empty value.  Without this they re-set
        // input.value = fillToken on the next render.
        input.setUserInput("");
        // Defer focus to the next frame so any synchronous re-render triggered
        // by the DOM cleanup above settles before we move focus.
        win.requestAnimationFrame(() => {
          if (input.isConnected) {
            input.removeAttribute("readonly");
            input.disabled = false;
            input.focus();
          }
        });
      }

      if (container.isConnected) {
        container.remove();
      }
      if (syncFixed) {
        doc.removeEventListener("scroll", syncFixed, { capture: true });
        win.removeEventListener("resize", syncFixed);
      }
      domObserver.disconnect();
      input.removeEventListener("copy", preventCopy, { capture: true });
      input.removeEventListener("cut", preventCopy, { capture: true });
    };

    // Use click (not mousedown) so the browser's focus management settles
    // before we call input.focus().  preventDefault on mousedown in Firefox
    // can interfere with subsequent programmatic focus calls.
    clearBtn.addEventListener("click", e => {
      e.stopPropagation();
      cleanup(/* clearValue */ true);
    });

    // ── Detect input removal from the DOM ──────────────────────────────────
    // For the absolute case we only need childList (the form being removed
    // already pulls the container out; we still need to restore input state).
    // For the fixed case we also track attribute changes to catch display:none.
    const domObserver = new MutationObserver(() => {
      if (!input.isConnected || !this.#isVisible(input)) {
        cleanup();
      }
    });
    domObserver.observe(doc, {
      childList: true,
      subtree: true,
      ...(useFixed && {
        attributes: true,
        attributeFilter: ["hidden", "style", "class"],
      }),
    });
  }

  /** Returns true when the element occupies layout space and is not hidden. */
  #isVisible(el) {
    if (!el.isConnected || el.closest("[hidden]")) {
      return false;
    }
    const cs = el.ownerGlobal?.getComputedStyle(el);
    return (
      cs?.display !== "none" &&
      cs?.visibility !== "hidden" &&
      el.offsetParent !== null
    );
  }
}
