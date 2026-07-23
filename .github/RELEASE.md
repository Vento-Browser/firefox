# Vento release & auto-update pipeline

`vento-release.yml` publishes a release to Google Cloud Storage and wires it into
the browser's auto-update mechanism. It runs on a release tag (`v*`) or manually.

## Flow

1. **build** — reuses `vento-build.yml` (via `workflow_call`) to produce signed
   binaries and signed full-update MARs for every platform, as run artifacts.
2. **publish** (`ubuntu-latest`):
   1. downloads all build artifacts;
   2. `publish-release.sh stage` lays them into the bucket tree and rewrites each
      MAR's `publish.json` `mar_url` to its final public GCS URL;
   3. `google-github-actions/auth@v2` authenticates with the `GCP_CREDENTIALS`
      service-account key (role: Storage Object Admin);
   4. `google-github-actions/upload-cloud-storage@v2` uploads the staged tree;
   5. `publish-release.sh register` POSTs each `publish.json` to the backend's
      `POST /api/updates` (ADMIN), which makes its `update.xml` advertise the
      build to clients.

Version and build ID come from the built binaries (`application.ini`), not the
tag — the tag is only the release marker.

## Bucket layout — `gs://vento-releases`

Multi-region `eu`, Uniform access (public read), no per-object ACLs.

```
releases/                              # immutable, versioned artifacts
  <version>/                           # e.g. 128.0
    macos/aarch64/
      Vento-<version>.dmg
      vento-<version>-<buildid>-Darwin_aarch64-gcc3.complete.mar
      <mar>.publish.json               # release manifest (provenance)
    windows/x86_64/
      Vento-Setup-<version>.exe
      vento-<version>-<buildid>-WINNT_x86_64-msvc.complete.mar
latest/                                # mutable channel pointers, overwritten each release
  release/
    macos/aarch64/Vento.dmg            # stable "download latest" links for the website
    windows/x86_64/Vento-Setup.exe
```

The browser's updater fetches the MAR straight from its GCS URL; only the
`update.xml` metadata is served by the backend. MARs live in the immutable
`releases/<version>/…` tree so a published build's URL never changes.

## Required GitHub configuration

Secrets:
- `GCP_CREDENTIALS` — service-account JSON key (Storage Object Admin) — **required**.
- `MAR_SIGNING_NSSDB_B64` — `tar czf - -C <nssdb-parent> nssdb | base64` of the NSS
  DB holding the MAR signing key. Until set, MAR generation is skipped (binaries
  still upload, but no auto-update is registered).
- `VENTO_ADMIN_TOKEN` — backend ADMIN JWT for registering the update. Until set,
  registration is skipped (upload still runs).
- Signing/notarization secrets are inherited from `vento-build.yml`
  (`MACOS_*`, `WINDOWS_CERTIFICATE_*`).

Variables (`vars`):
- `GCS_BUCKET` — bucket name (default `vento-releases`).
- `VENTO_BACKEND_URL` — backend base URL, e.g. `https://api.vento-browser.com`.
