/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
});

const PREF_ENABLED = "browser.vento.mcp.enabled";
const PREF_PORT = "browser.vento.mcp.port";
const DEFAULT_PORT = 9223;

// Written into the profile so AI clients (Claude Code, etc.) can be pointed at
// Vento's bundled MCP server with a single config include.
const REGISTRATION_FILENAME = "vento-mcp.json";

/**
 * Wires Vento's native MCP integration to the rest of the browser.
 *
 * The actual MCP server is a separate bundled binary (`vento-mcp`, from the
 * Vento-Browser/vento_mcp repository) that drives this browser over its
 * WebDriver BiDi endpoint. When PREF_ENABLED is set, RemoteAgent starts that
 * endpoint on PREF_PORT at startup (see RemoteAgent.#handleVentoMcpPref). This
 * module's job is to advertise the server: it writes a ready-to-use MCP client
 * registration into the profile describing how to launch the bundled binary
 * against the configured port.
 */
export const VentoMcp = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    if (!Services.prefs.getBoolPref(PREF_ENABLED, false)) {
      return;
    }
    this._writeRegistration().catch(e =>
      console.error(`VentoMcp: failed to write MCP registration: ${e}`)
    );
  },

  get port() {
    return Services.prefs.getIntPref(PREF_PORT, DEFAULT_PORT);
  },

  /**
   * Absolute path to the bundled `vento-mcp` executable, which ships next to
   * the browser binary.
   */
  get binaryPath() {
    const exeDir = Services.dirsvc.get("XREExeF", Ci.nsIFile).parent;
    const name =
      lazy.AppConstants.platform === "win" ? "vento-mcp.exe" : "vento-mcp";
    return PathUtils.join(exeDir.path, name);
  },

  /**
   * MCP client configuration object pointing at the bundled server. The shape
   * matches the `mcpServers` map understood by Claude Code and compatible
   * clients.
   */
  registration() {
    return {
      mcpServers: {
        vento: {
          command: this.binaryPath,
          args: ["--bidi-port", String(this.port)],
        },
      },
    };
  },

  async _writeRegistration() {
    const path = PathUtils.join(
      Services.dirsvc.get("ProfD", Ci.nsIFile).path,
      REGISTRATION_FILENAME
    );
    await IOUtils.writeJSON(path, this.registration());
    console.info(`VentoMcp: MCP server registration written to ${path}`);
  },
};
