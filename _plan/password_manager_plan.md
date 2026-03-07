# Password Manager

Нужно реализовать кастомный password manager. Требования такие:

1. Пароли хранятся удаленно (на стороне бэкенда в Postgress)
2. Паролями может управлять пользователь с правами PASSWORDS_MANAGE.  Также пользователь с такими правами может давать доступ другим пользователям.
3. Управление паролями осуществляется через Vento Panel. Нужно создать новое меню Hidden Passwords, в которое следует поместить список логинов/паролей, а также кнопку access. По нажатию на нее открывать окно со списком пользователей и галочкой рядом с каждым. Сверху окна разместить текстовый фильтр для поиска по имени пользователя или его email, а также кнопкой 'сохранить'.
4. Пользователи, которым разрешен доступ к паролю, не должны иметь возможность просмотреть его, но при этом должны иметь возможность его использовать с помощью автозаполнения. Я предлагаю такое решение: в текстовые поля вместо паролей подставлять что-нибудь вроде `{{PASSWORD_123}}`, где 123 -- id пароля. После этого при запросе значения текстового поля из javascript или отправке формы возвращать или отправлять нужный пароль вместо `{{PASSWORD_123}}`. Возможны альтернативные решения -- дай знать, если найдешь такое.
В этом случае возникнет проблема с тем, что пароль в любом случае будет в памяти, но нужно исходить из того, что такой риск приемлем.

---

## Implementation

### Backend (`vento_backend/src/passwords/`)

| File | Purpose |
|------|---------|
| `mod.rs` | Router + OpenAPI registration |
| `models.rs` | `PasswordRow` DB struct |
| `dto.rs` | Request / response DTOs (`PasswordResponse` never includes `value`) |
| `handlers.rs` | HTTP handlers |
| `service.rs` | Permission branching; `get_password_value` gated to owner or shared user |
| `repository.rs` | DB queries; `list_passwords_for_manager` vs `list_passwords_for_user` |

DB migration: `migrations/20260228002_passwords.sql` — tables `passwords`, `password_shares`; adds permission `PASSWORDS_MANAGE`.

Endpoints:

| Method | Path | Permission |
|--------|------|-----------|
| `GET` | `/api/passwords` | Any auth (filtered by access) |
| `POST` | `/api/passwords` | `PASSWORDS_MANAGE` |
| `PUT` | `/api/passwords/{id}` | `PASSWORDS_MANAGE` + owner |
| `DELETE` | `/api/passwords/{id}` | `PASSWORDS_MANAGE` + owner |
| `GET` | `/api/passwords/{id}/value` | Owner or shared user |
| `GET` | `/api/passwords/{id}/access` | `PASSWORDS_MANAGE` + owner |
| `PUT` | `/api/passwords/{id}/access` | `PASSWORDS_MANAGE` + owner |

### Vento Panel UI (`firefox/browser/components/vento/`)

Hidden Passwords page added to `vento-page.mjs`. Features:
- Paginated credential list (title, URL, username)
- Inline create / edit form (`PASSWORDS_MANAGE` only)
- Access dialog — filter by name/email, checkbox per user, Save/Cancel
- Fill button — injects credential into the best matching tab without exposing the password

### Secure Fill Architecture

The original `{{PASSWORD_id}}` placeholder idea was replaced with a stronger model that keeps the plaintext confined to the parent (browser) process.

**Data flow:**

```
vento-page.mjs  →  VentoPasswordParent.secureFill()
                       ↓ fetch GET /api/passwords/{id}/value   (parent process, HTTPS)
                       ↓ VentoCredentialService.issueToken()   → "VENTO_CRED:<UUID>"
                       ↓ sendQuery("VentoPassword:Fill", { username, fillToken })
                   VentoPasswordChild (content process)
                       ↓ input.setUserInput(fillToken)          (opaque token in DOM)
                   VentoNetworkObserver  ←  http-on-modify-request
                       ↓ resolve token, verify origin, replace in HTTP body
                       → real password sent to server
```

**New files:**

| File | Process | Role |
|------|---------|------|
| `browser/components/vento/VentoCredentialService.sys.mjs` | Parent | Token store; one-shot, origin-bound, 60 s TTL, bytes zeroed on use |
| `browser/components/VentoNetworkObserver.sys.mjs` | Parent | `http-on-modify-request` observer; substitutes token → password in POST body |

**Modified files:**

| File | Change |
|------|--------|
| `VentoPasswordParent.sys.mjs` | Fetches secret, issues token, sends only token to child |
| `VentoPasswordChild.sys.mjs` | Fills field with token; cancels `MozWillToggleReveal` |
| `vento-page.mjs` | `#fillPassword` calls `actor.secureFill()` — no `pwValue` in this file |
| `jar.mn` | Added `VentoCredentialService.sys.mjs` |
| `browser/components/moz.build` | Added `VentoNetworkObserver.sys.mjs` to `EXTRA_JS_MODULES` |
| `BrowserGlue.sys.mjs` | Lazy-imports and calls `VentoNetworkObserver.init()` at startup |

**Security properties:**
- `input.value` in page JS returns the opaque token, not the password
- Token is origin-bound: `VentoNetworkObserver` only substitutes into requests whose origin matches the credential's stored URL; XHR to a different host gets the token (useless)
- Token is one-shot and expires after 60 seconds
- Password bytes (`Uint8Array`) are zeroed after use
- `MozWillToggleReveal` is cancelled, suppressing the browser's reveal-password button
