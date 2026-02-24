# Firefox Full Rebranding Plan

## Overview

Firefox's branding is organized by build channel (official, aurora, nightly, unofficial). Changes must be made in each channel's directory, plus shared toolkit/localization files.

**Before starting:** Decide on:
- New browser name (replaces "Firefox" / "Mozilla Firefox")
- New vendor/company name (replaces "Mozilla" / "Mozilla Corporation")
- New brand colors
- New logo/icon set

---

## 1. Localization Strings (Highest Priority)

These files define the brand name strings used everywhere in the UI.

### Desktop brand strings
Replace `brandShorterName`, `brandShortName`, `brandFullName`, `brandProductName`, `vendorShortName` in:

- `browser/branding/official/locales/en-US/brand.ftl`
- `browser/branding/official/locales/en-US/brand.properties`
- `browser/branding/aurora/locales/en-US/brand.ftl`
- `browser/branding/aurora/locales/en-US/brand.properties`
- `browser/branding/nightly/locales/en-US/brand.ftl`
- `browser/branding/nightly/locales/en-US/brand.properties`
- `browser/branding/unofficial/locales/en-US/brand.ftl`
- `browser/branding/unofficial/locales/en-US/brand.properties`

### Mobile Android brand strings
- `mobile/android/branding/official/locales/en-US/brand.ftl`
- `mobile/android/branding/official/locales/en-US/brand.properties`
- `mobile/android/branding/beta/locales/en-US/brand.ftl`
- `mobile/android/branding/beta/locales/en-US/brand.properties`
- `mobile/android/branding/nightly/locales/en-US/brand.ftl`
- `mobile/android/branding/nightly/locales/en-US/brand.properties`
- `mobile/android/branding/unofficial/locales/en-US/brand.ftl`
- `mobile/android/branding/unofficial/locales/en-US/brand.properties`

### Toolkit cross-product brand strings
References to Firefox Monitor, Firefox VPN, Pocket (Mozilla-owned services):
- `toolkit/locales/en-US/toolkit/branding/brandings.ftl`

---

## 2. Application Icons

All icons must be replaced with new artwork. Keep the same filenames and sizes.

### Desktop icons (per channel: official, aurora, nightly, unofficial)

**Windows** (`browser/branding/<channel>/`):
- `default16.png` through `default256.png` (8 sizes)
- `firefox.ico`
- `firefox64.ico`
- `document.ico`
- `newwindow.ico`
- `newtab.ico`
- `pbmode.ico`
- `document_pdf.ico`

**macOS** (`browser/branding/<channel>/`):
- `firefox.icns`
- `document.icns`
- `disk.icns`

**Linux** (uses the default PNG set)

### About page logos (per channel)
- `browser/branding/<channel>/content/about-logo.png` (128x128)
- `browser/branding/<channel>/content/about-logo@2x.png` (256x256)
- `browser/branding/<channel>/content/about-logo-private.png`
- `browser/branding/<channel>/content/about-logo-private@2x.png`
- `browser/branding/<channel>/content/about-logo.svg`

### Wordmarks
- `browser/branding/<channel>/content/firefox-wordmark.svg`
- `browser/branding/<channel>/content/about-wordmark.svg`

### Windows Store (MSIX) assets (official channel only)
All files under `browser/branding/official/msix/Assets/`:
- `StoreLogo.scale-200.png`
- `Square44x44Logo.scale-200.png`
- `Square150x150Logo.scale-200.png`
- `LargeTile.scale-200.png`
- `SmallTile.scale-200.png`
- `Wide310x150Logo.scale-200.png`
- `Square44x44Logo.targetsize-256.png`
- `Square44x44Logo.altform-unplated_targetsize-256.png`
- `Square44x44Logo.altform-lightunplated_targetsize-256.png`
- `Document44x44.png`

### Windows tile images (per channel)
- `browser/branding/<channel>/VisualElements_70.png`
- `browser/branding/<channel>/VisualElements_150.png`
- `browser/branding/<channel>/PrivateBrowsing_70.png`
- `browser/branding/<channel>/PrivateBrowsing_150.png`

### Windows installer images (per channel)
- `browser/branding/<channel>/wizHeader.bmp`
- `browser/branding/<channel>/wizHeaderRTL.bmp`
- `browser/branding/<channel>/wizWatermark.bmp`
- `browser/branding/<channel>/background.png`
- `browser/branding/<channel>/about.png`

### Mobile Android icons
Under `mobile/android/branding/<channel>/`:
- `favicon32.png`, `favicon64.png`
- `about.png`
- All mipmap drawable icons (launcher icons in various densities)

---

## 3. Windows Installer Configuration

### NSIS branding definitions (per channel)
Edit `browser/branding/<channel>/branding.nsi`:
- `BrandFullNameInternal` — registry key name
- `BrandFullName` — displayed name
- `CompanyName` — company string
- `URLInfoAbout`, `URLUpdateInfo`, `HelpLink` — update to new domain
- `CertNameDownload` — certificate subject name

### Windows Visual Elements Manifests (per channel)
Edit `browser/branding/<channel>/firefox.VisualElementsManifest.xml`:
- Start menu tile background color
- Logo image paths (if renaming files)

Edit `browser/branding/<channel>/private_browsing.VisualElementsManifest.xml` similarly.

---

## 4. Distribution and Installer Metadata

### Distribution config files
Update `about` and `id` fields in:
- `browser/app/distribution/distribution.ini`
- `browser/installer/linux/app/debian/distribution.ini`
- `browser/installer/linux/app/rpm/distribution.ini`
- `browser/installer/windows/msix/distribution/distribution.ini`

### Linux Debian package metadata
- `browser/installer/linux/app/debian/control.in` — package name, maintainer, description
- `browser/installer/linux/app/debian/changelog.in`
- `browser/installer/linux/app/debian/manpage.1.in`

### Linux RPM package metadata
- `browser/installer/linux/app/rpm/firefox.spec.j2` — package name, summary, vendor

### Flatpak metadata
- `browser/installer/linux/app/flatpak/metadata.in`
- `browser/installer/linux/app/flatpak/org.mozilla.firefox.appdata.xml.in` — AppStream app ID, name, summary

---

## 5. Browser Preferences and URLs

### Channel branding preferences
Edit `browser/branding/<channel>/pref/firefox-branding.js` in each channel:
- Homepage override URLs
- Welcome/first-run page URLs (`startup.homepage_welcome_url`)
- Update check and release notes URLs
- Support/help URLs

These typically point to `firefox.com` or `mozilla.org` domains that must be changed.

---

## 6. About Dialog

The About Firefox dialog pulls from branding strings automatically, but the XHTML template may contain hardcoded references:
- `browser/base/content/aboutDialog.xhtml` — check for hardcoded "Mozilla" or "Firefox" text
- `browser/base/content/aboutDialog.css` — branding-specific styles (logo display area)

---

## 7. Build System Variables

### Application name in build config
The `MOZ_APP_NAME` variable controls the binary name and many paths. Set in:
- `browser/confvars.sh` or equivalent — update `MOZ_APP_NAME`, `MOZ_APP_DISPLAYNAME`
- `old-configure.in` / `configure.py` — product name references
- `browser/branding/branding-common.mozbuild` — shared branding build logic

### Executable filename
Changing `MOZ_APP_NAME` renames the binary from `firefox` to the new name. This affects:
- Installed binary path
- Profile directory name
- macOS `.app` bundle name

---

## 8. Trademark and Legal

### License file
- `browser/branding/official/LICENSE` — contains Mozilla trademark notice; replace with new trademark/license text

### About page trademark notice
The `trademarkInfo` string in brand.ftl / brand.properties contains the trademark statement displayed in the About dialog. Update to reflect new ownership.

---

## 9. New Tab Page and Onboarding

The new tab page and onboarding flows contain visual branding references:
- `browser/extensions/newtab/prerendered/activity-stream.html` — prerendered; will need rebuild after branding changes
- `browser/components/aboutwelcome/content/` — onboarding HTML, CSS, JS

These pull brand names from localization files (covered in section 1), but may contain hardcoded image references or class names that assume the Firefox logo shape/colors.

---

## 10. macOS-Specific

### App bundle name
The `.app` bundle name is derived from `MOZ_APP_DISPLAYNAME`. Update accordingly.

### Update guide for macOS icons
Follow the guide at `browser/branding/docs/UpdatingMacIcons.rst` when replacing `.icns` files to ensure correct format and pixel densities.

---

## Implementation Order

1. **Decide new name and assets** — without this nothing else can proceed
2. **Replace all icon files** (sections 2) — can be done in parallel
3. **Update localization strings** (section 1) — all brand name occurrences in UI
4. **Update installer configs** (sections 3, 4) — installer and packaging metadata
5. **Update branding preferences** (section 5) — URLs and feature flags
6. **Update build system variables** (section 7) — binary name, bundle name
7. **Update legal text** (section 8)
8. **Rebuild and verify** — `./mach build`, check About dialog, new tab, installer

---

## Notes

- All 4 desktop channels (official, aurora, nightly, unofficial) and 4 mobile channels need separate updates. Sections above with `<channel>` mean all of them.
- The `unofficial` channel is used for local developer builds — this is the one to test with first.
- Searchfox is not useful for finding hardcoded brand name strings in HTML/JS/localization files; use `rg 'Firefox|Mozilla' --type=ftl` scoped to specific directories for those.
- After renaming the binary (`MOZ_APP_NAME`), update any CI scripts, shell scripts, and documentation that invoke `firefox` by name.
