# Code signing & notarization (Vento)

The build workflow (`.github/workflows/vento-build.yml`) signs the macOS and
Windows artifacts when the required secrets are present. Until they are set the
workflow stays green: macOS falls back to ad-hoc signing and the Windows signing
step is a no-op. This document explains how to obtain the certificates and which
GitHub Actions secrets to create.

All secrets live in the `Vento-Browser/firefox` repo:
`Settings → Secrets and variables → Actions → New repository secret`.

## macOS — Apple Developer ID + notarization

Requires a paid **Apple Developer Program** membership ($99/year).

1. **Developer ID Application certificate**
   - developer.apple.com → Certificates → `+` → *Developer ID Application*.
   - Create a CSR with Keychain Access
     (*Keychain Access → Certificate Assistant → Request a Certificate from a
     Certificate Authority*, "Saved to disk"), upload it, download the `.cer`.
   - Double-click the `.cer` to import it into the login keychain, then in
     Keychain Access select the certificate **together with its private key**,
     right-click → *Export* → `.p12`, and set a password.
   - Encode it: `base64 -i DeveloperID.p12 | pbcopy`.
   - Secrets:
     - `MACOS_CERTIFICATE_P12_B64` — the base64 blob above.
     - `MACOS_CERTIFICATE_PASSWORD` — the `.p12` password.
     - `MACOS_SIGN_IDENTITY` *(optional)* — the identity string, e.g.
       `Developer ID Application: Your Name (TEAMID)`. If omitted, CI auto-detects
       the first Developer ID Application identity in the keychain.

2. **App Store Connect API key for notarytool**
   - appstoreconnect.apple.com → Users and Access → Integrations → App Store
     Connect API → `+`. Role *Developer* is enough for notarization.
   - Download the `.p8` **once** (it cannot be re-downloaded). Note the *Key ID*
     and the *Issuer ID* shown on the same page.
   - Encode the key: `base64 -i AuthKey_XXXX.p8 | pbcopy`.
   - Secrets:
     - `MACOS_NOTARY_API_KEY_B64` — base64 of the `.p8`.
     - `MACOS_NOTARY_API_KEY_ID` — the Key ID.
     - `MACOS_NOTARY_API_ISSUER_ID` — the Issuer ID (UUID).

CI then signs the `.app` with hardened runtime + production entitlements
(`mach macos-sign -e production-without-restricted -c release`), signs the DMG,
submits it to `notarytool` and staples the ticket.

## Windows — Authenticode

Buy a code-signing certificate. Recommended: **Azure Trusted Signing** (cheapest,
cloud HSM) or an OV/EV cert from **SSL.com** / **DigiCert**. The workflow step
below uses a PFX file, which fits an OV certificate exported as `.pfx`. (EV certs
are HSM-bound; for those switch the step to the provider's cloud signing action —
see note at the end.)

1. Export the certificate + private key as a password-protected `.pfx`.
2. Encode it: `base64 -w0 cert.pfx` (or on macOS `base64 -i cert.pfx`).
3. Secrets:
   - `WINDOWS_CERTIFICATE_PFX_B64` — base64 of the `.pfx`.
   - `WINDOWS_CERTIFICATE_PASSWORD` — the `.pfx` password.

CI signs the SEA installer under `obj-*/dist/install/sea/*.exe` with `signtool`
(SHA-256 + RFC-3161 timestamp from DigiCert).

> Per-binary signing (firefox.exe and the bundled DLLs inside the package) is not
> done yet — only the downloaded installer is signed, which is what SmartScreen
> gates on. Signing every binary would require re-packaging after signing and can
> be added later.

### Using an EV / cloud-HSM certificate instead of a PFX

EV certificates cannot be exported to a `.pfx`. Replace the *Sign installer*
step with the provider's action, e.g. `azure/trusted-signing-action` (needs
`AZURE_*` service-principal secrets) or SSL.com eSigner (`CodeSignTool`). The
target files are still `obj-*/dist/install/sea/*.exe`.

## Secret summary

| Secret | Platform | Purpose |
| --- | --- | --- |
| `MACOS_CERTIFICATE_P12_B64` | macOS | Developer ID Application cert + key (base64 `.p12`) |
| `MACOS_CERTIFICATE_PASSWORD` | macOS | `.p12` password |
| `MACOS_SIGN_IDENTITY` | macOS | (optional) identity string override |
| `MACOS_NOTARY_API_KEY_B64` | macOS | App Store Connect API key (base64 `.p8`) |
| `MACOS_NOTARY_API_KEY_ID` | macOS | API Key ID |
| `MACOS_NOTARY_API_ISSUER_ID` | macOS | API Issuer ID |
| `WINDOWS_CERTIFICATE_PFX_B64` | Windows | Authenticode cert + key (base64 `.pfx`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows | `.pfx` password |
