/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Vento branding disables the sync engines on the default pref branch.
// Manifest prefs only set the user branch, which Service.startOver() and
// per-test cleanup wipe, so restore the upstream defaults here instead.
{
  const defaults = Services.prefs.getDefaultBranch("");
  for (let engine of [
    "addons",
    "bookmarks",
    "history",
    "passwords",
    "prefs",
    "tabs",
  ]) {
    defaults.setBoolPref(`services.sync.engine.${engine}`, true);
  }
}
