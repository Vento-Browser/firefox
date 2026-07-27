# Vento Fingerprint — backend-выдача профиля (контракт)

Этот документ описывает **отдельный, отделяемый в свой репозиторий**
backend-компонент выдачи фингерпринт-профилей — по образцу `vento_license` и
`vento_feedback`. Он фиксирует контракт (REST-форму и формат данных), которого
придерживается Firefox-клиент `browser/components/vento/fingerprint/VentoFingerprintService.sys.mjs`.
Сама реализация сервера живёт вне дерева Firefox; здесь — только граница.

## Зачем отдельный компонент

Ключевое свойство Vento — **детерминированная идентичность**: два пользователя с
одним и тем же профилем на разных машинах должны для сайта выглядеть одинаково.
Значит профиль (в первую очередь его `seed`) должен **раздаваться централизованно**
— чтобы группа пользователей гарантированно имела один и тот же профиль. Это и есть
задача backend-компонента: хранить профили, выдавать их клиенту и принимать правки
из редактора в Vento-панели.

## Формат профиля (единый источник истины)

Сериализованный профиль — то, что возвращает `VentoFingerprintProfile.export()`:

```json
{
  "version": 1,
  "seed": "<непустая строка — мастер-секрет; из него детерминированно выводятся ВСЕ шумовые сиды>",
  "label": "Amazon desktop",
  "fields": {
    "userAgent": "…",
    "platform": "Win32",
    "oscpu": "Windows NT 10.0; Win64; x64",
    "hardwareConcurrency": 8,
    "deviceMemory": 8,
    "locale": "en-US",
    "timezone": "Europe/Berlin",
    "screen": { "width": 1920, "height": 1080, "colorDepth": 24 },
    "devicePixelRatio": 1,
    "maxTouchPoints": 0,
    "gpuVendor": "Google Inc. (Intel)",
    "gpuRenderer": "ANGLE (Intel, …)",
    "fonts": ["Arial", "Courier New", "…"]
  }
}
```

Правила формата:

- **`version`** — версия формата (`PROFILE_FORMAT_VERSION`). Только метаданные:
  в вывод seed НЕ входит, поэтому два профиля, различающиеся лишь версией, дают
  идентичный фингерпринт. Клиент мигрирует более старый payload вперёд
  (`VentoFingerprintProfile.migrate()`), а payload из более НОВОГО браузера
  (`version` больше поддерживаемой) — отклоняет, а не додумывает. Сервер обязан
  хранить `version` как есть и не перезаписывать её при отдаче.
- **`seed`** — единственный источник энтропии. Одинаковый seed ⇒ одинаковый
  результат. Никогда не генерировать его на клиенте для «общего» профиля — он
  должен приходить с сервера.
- **`fields`** — явные статические переопределения. Любое отсутствующее поле
  детерминированно выводится из seed на клиенте. Набор допустимых ключей и их
  типы описаны в `VentoFingerprintProfile.PROFILE_FIELD_SCHEMA` (единый источник
  для редактора панели и валидации). Сервер валидирует по той же схеме.

## REST-контракт

Base URL берётся из pref `vento.fingerprint.api.url`. Авторизация — тот же
Bearer-JWT, что и остальной backend Vento (`Authorization: Bearer <token>`).

### `GET /api/fingerprint/profile`

Вернуть активный профиль пользователя (или профиль его группы). Тело ответа —
сериализованный профиль (см. выше). `200` + JSON. Клиент: `fetchRemote()`.

### `PUT /api/fingerprint/profile`

Принять отредактированный в Vento-панели профиль. Тело запроса —
сериализованный профиль. Сервер валидирует по схеме, сохраняет, отвечает `2xx`.
Клиент: `pushRemote()`.

Ошибки: любой не-2xx ответ клиент трактует как ошибку и НЕ применяет профиль
(никакого «тихого» пустого профиля — это защитило бы от подмены на неполный).

## Точки врезки на стороне Firefox (минимальные, для отделения)

Весь клиентский код изолирован в `fingerprint/`:

- `VentoFingerprintService.sys.mjs` — HTTP-клиент + запись префов
  (`applyProfile` → `VentoFingerprintComposer.composePrefs`). Все внешние
  зависимости (pref-ветка, `fetch`) инъектируются, поэтому весь путь
  pull → import → cache → apply покрыт xpcshell-тестом без сети и без живого
  nsRFPService (`test_vento_fingerprint_service.js`).
- `VentoFingerprintComposer.sys.mjs` — единый композитор + чек-лист deny-by-default.
- `VentoFingerprintProfile.sys.mjs` — формат/версионирование/деривация seed.

Чтобы вынести всё в отдельный репозиторий, достаточно забрать каталог
`fingerprint/`; в ядре Firefox остаётся только одна нативная врезка
(`nsRFPService::GetBrowsingSessionKey`, см. `fingerprint/README.md`) и вызов
`VentoFingerprintService` из BrowserGlue при старте (будущая задача врезки).
