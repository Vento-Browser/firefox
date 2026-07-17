# Mozilla/Google background connections audit

Status: 2026-07-17. Decisions for every background connection the browser can
make without an explicit user action. Context: all external traffic is forced
through vento_proxy (locked SOCKS prefs; before login a blocking proxy allows
only localhost and the Vento backend), so "keep" below always means
"keep, tunnelled through vento_proxy".

Prefs implementing the "disable" decisions live in
`browser/branding/vento/pref/firefox-branding.js` and are covered by
`browser/components/vento/tests/browser/browser_vento_connections.js`.

| Connection | Endpoint | Decision | How |
|---|---|---|---|
| Telemetry / FHR / Glean | incoming.telemetry.mozilla.org | **Disable** | `datareporting.*`, `toolkit.telemetry.*` (server set to `data:,` as belt-and-braces) |
| Newtab/activity-stream telemetry, ping-centre | tiles.services.mozilla.com | **Disable** | `browser.ping-centre.telemetry`, `browser.newtabpage.activity-stream.*telemetry*` |
| Normandy/Shield recipes, studies | normandy.cdn.mozilla.net | **Disable** | `app.normandy.enabled=false`, empty `api_url`, `app.shield.optoutstudies.enabled=false` |
| Nimbus experiments | via Remote Settings | **Disable** | `messaging-system.rsexperimentloader.enabled=false` |
| Crash reporter auto-submit | crash-reports.mozilla.com | **Disable** (manual submission still possible from about:crashes) | `browser.crashReports.unsubmittedCheck.*` |
| Captive portal / connectivity probes | detectportal.firefox.com | **Disable** (probes are meaningless behind the mandatory proxy and leak wake-up timing) | `network.captive-portal-service.enabled`, `network.connectivity-service.enabled`, empty `captivedetect.canonicalURL`; also enforced at runtime by VentoProxy hardening |
| Sponsored top sites | contile.services.mozilla.com | **Disable** | `browser.topsites.contile.enabled` + `showSponsored*` |
| Pocket / top stories | getpocket.cdn.mozilla.net | **Disable** | `extensions.pocket.enabled`, `feeds.section.topstories` |
| Urlbar quick suggest (network part) | merino.services.mozilla.com | **Disable** | `browser.urlbar.merino.enabled=false`; note: `quicksuggest.enabled` has a runtime-managed default (region scenario), but with Merino off its remaining suggestions come from local Remote Settings data |
| UITour | www.mozilla.org | **Disable** | `browser.uitour.enabled` |
| Safe Browsing download metadata | sb-ssl.google.com | **Disable** — download URLs/hashes are never sent to Google | `browser.safebrowsing.downloads.remote.enabled=false` |
| Safe Browsing list updates & hash-prefix checks | safebrowsing.googleapis.com | **Keep** — real phishing/malware protection; only 4-byte hash prefixes leave the browser, via the proxy | default prefs |
| Tracking-protection lists (ETP) | shavar.services.mozilla.com | **Keep** — required for Enhanced Tracking Protection | default prefs |
| Remote Settings | firefox.settings.services.mozilla.com | **Keep** — carries OneCRL/CRLite (TLS certificate revocation), add-on blocklist, password rules. Disabling would silently break revocation. Experiment collections are inert with Nimbus/Normandy off | default prefs |
| Add-ons: AMO search/install/updates, blocklist | addons.mozilla.org, versioncheck.addons.mozilla.org | **Keep** — users install and update extensions; blocklist is a security feature | default prefs |
| GMP plugin updates (Widevine/OpenH264) | aus5.mozilla.org, Google CDN | **Keep** — needed for DRM video and H.264 calls; fetched only when used | default prefs |
| App update check | vento-browser.com (MOZ_APPUPDATE_HOST) | **Keep (ours)** — already points at the Vento update service, not Mozilla | build config |
| Geolocation service | googleapis.com/geolocation | **Keep** — contacted only after a site is explicitly granted the geolocation permission | default prefs |
| Web Push | push.services.mozilla.com | **Keep** — breaking it would break web-app notifications; connection is proxied. Revisit if the persistent UAID is deemed unacceptable | default prefs |
| OCSP / CRL | CA responders | **Keep** — certificate validation | default prefs |
| Search suggestions | default engine (user-visible) | **Keep** — triggered by typing in the urlbar, not background; engine set is a separate legal task | default prefs |
| WebRTC ICE/STUN | any | **Already disabled & locked** (leak vector) | `media.peerconnection.*` locked in branding |
| DNS prefetch, TRR, HTTP/3 | various | **Already disabled** at runtime by VentoProxy hardening (UDP/DNS paths that could bypass the SOCKS tunnel) | VentoProxy.sys.mjs |

## Open questions

- Web Push keeps a persistent WebSocket to Mozilla with a stable UAID even
  with no subscriptions; acceptable for now since it is proxied. Flip
  `dom.push.connection.enabled` if product decides otherwise.
- Safe Browsing hash-prefix checks go to Google; the privacy cost is 4-byte
  prefixes. If product prefers zero Google traffic, disable
  `browser.safebrowsing.{malware,phishing}.enabled` and accept losing
  anti-phishing protection.
