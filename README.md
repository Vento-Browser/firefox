# Vento Browser

Vento is a fast, private and team-oriented web browser built on the
[Firefox](https://firefox.com/) source code from the non-profit
[Mozilla organization](https://mozilla.org/).

On top of the Firefox foundation, Vento adds:

* **Built-in proxy** — a SOCKS5 proxy integration that keeps traffic private,
  with leak protection.
* **Team credential management** — secure autofill that never exposes
  plaintext passwords to the content process, plus browser login sync.
* **Vento sidebar panel** — user, permission and workspace management
  backed by the Vento backend.
* **Encrypted session vault** — tabs, cookies and history are encrypted on
  logout.
* **Managed updates and licensing** — Ed25519-signed licenses and a dedicated
  update channel.

### Building

Vento is built with the standard Mozilla build system. See the
[Firefox Contributors' Quick Reference document](https://firefox-source-docs.mozilla.org/contributing/contribution_quickref.html)
for setting up a build environment, then:

```
./mach build      # full build (can take tens of minutes)
./mach run        # launch the browser
./mach test --auto  # run tests
```

For front-end-only changes use `./mach build faster`; for C/C++/Rust-only
changes use `./mach build binaries`.

### Resources

* [Firefox Source Docs](https://firefox-source-docs.mozilla.org/) documents the
  underlying platform and build system.
* Project documentation is published at
  [docs.vento-browser.com](https://docs.vento-browser.com/).

### Trademarks & licensing

Vento is a derivative of Firefox. The Firefox and Mozilla names and logos are
trademarks of the Mozilla Foundation and are not used to identify Vento
builds. See the file `toolkit/content/license.html` for the copyright and
licensing conditions attached to this codebase.
