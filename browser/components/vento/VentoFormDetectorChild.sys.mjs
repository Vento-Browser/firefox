/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActorChild — runs in the content process.
 *
 * Detects password fields on the page and requests a fill from
 * VentoFormDetectorParent.  When the parent replies with a fill token, the
 * username and password fields are filled via the privileged setUserInput()
 * path — identical to the manual Fill flow in VentoPasswordChild.
 *
 * Trigger: pageshow — fires on every page navigation and bfcache restore.
 * We intentionally avoid DOMFormHasPassword / DOMInputPasswordAdded because
 * those events are gated on the signon.autofillForms pref, which is set to
 * false in the Vento branding profile to disable Firefox's native autofill.
 *
 * On pageshow we scan for a password field ourselves.  If none is found the
 * actor does nothing and exits cheaply.
 *
 * Each actor instance lives for one page.  The #requested flag prevents
 * duplicate fill requests (pageshow can fire more than once, e.g. bfcache).
 */
export class VentoFormDetectorChild extends JSWindowActorChild {
  /** Prevents sending more than one lookup per page load. */
  #requested = false;

  /**
   * WeakRef to the password input found during handleEvent.
   * Used to fill that specific input when the parent responds, avoiding a
   * second querySelectorAll traversal in the common case.
   */
  #pendingInput = null;

  handleEvent(event) {
    if (event.type !== "pageshow") {
      return;
    }
    // Only send one request per page; pageshow can fire again from bfcache.
    if (this.#requested) {
      return;
    }

    // Only autofill in the top-level document, not inside iframes.
    if (this.contentWindow !== this.contentWindow?.top) {
      return;
    }

    const origin = this.contentWindow?.location?.origin;
    if (!origin || origin === "null") {
      return;
    }

    // Scan for a visible password field.  If there is none this page is not
    // a login form and we exit without contacting the parent.
    const doc = this.document;
    const input = doc
      ? Array.from(doc.querySelectorAll("input[type=password]")).find(
          el => !el.disabled && !el.readOnly && this.#isVisible(el)
        )
      : null;

    if (!input) {
      console.log("[VentoFormDetector] pageshow: no password field on", origin);
      return;
    }

    console.log(
      "[VentoFormDetector] pageshow: password field found, requesting credentials for",
      origin
    );
    this.#pendingInput = new WeakRef(input);
    this.#requested = true;

    this.sendAsyncMessage("VentoFormDetector:LookupCredentials", { origin });
  }

  receiveMessage(message) {
    if (message.name !== "VentoFormDetector:FillCredentials") {
      return;
    }

    console.log(
      "[VentoFormDetector] received FillCredentials, username:",
      message.data.username
    );

    const { username, fillToken } = message.data;
    if (!fillToken) {
      console.error("[VentoFormDetector] FillCredentials: fillToken is empty");
      return;
    }

    // Resolve the target password input.  Prefer the stored reference from
    // when pageshow fired; fall back to a fresh DOM query in case the element
    // was replaced (e.g. by a JS framework re-render).
    let pwInput = this.#pendingInput?.deref();
    if (!pwInput || !this.#isVisible(pwInput)) {
      pwInput = this.document?.querySelector("input[type=password]");
    }
    this.#pendingInput = null;

    if (!pwInput || !this.#isVisible(pwInput)) {
      console.error(
        "[VentoFormDetector] FillCredentials: password input not found or not visible"
      );
      return;
    }

    console.log("[VentoFormDetector] filling password field", pwInput);

    // Fill username into the last visible text/email input that precedes the
    // password field within the same form (or anywhere on the page).
    if (username) {
      const scope = pwInput.closest("form") ?? this.document;
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
    // setUserInput() is a privileged method that fires proper input/change
    // events so the page's form validation and framework bindings are
    // triggered, while bypassing the normal JS value setter.
    pwInput.setUserInput(fillToken);
    pwInput.focus();

    // Suppress the "reveal password" eye icon so it cannot expose the token.
    pwInput.addEventListener("MozWillToggleReveal", e => e.preventDefault(), {
      capture: true,
    });
  }

  /**
   * Returns true when the element occupies layout space and is not hidden.
   *
   * @param el
   */
  #isVisible(el) {
    return el.offsetParent !== null && !el.closest("[hidden]");
  }
}
