# Замена инфраструктуры Mozilla на собственную

## Контекст и что уже сделано

Уже реализовано:
- `browser/base/content/loginGate.html` + `loginGate.js` — кастомная форма логина, подключающаяся к собственному серверу по HTTP API
- `browser/components/VentoWebSocket.sys.mjs` — постоянное WebSocket-соединение с сервером, хранение токена в `browser.logingate.accessToken`
- `gVentoWsIndicator` в `browser-init.js` — индикатор статуса соединения с блокировкой UI при отключении
- Инициализация `VentoWebSocket.init()` добавлена в `BrowserGlue.sys.mjs` → `_firstWindowLoaded()`

---

## Что нужно заменить

### 1. Firefox Accounts (FxA) — аккаунт Mozilla, вход/профиль
### 2. Менеджер паролей (Lockwise/LoginManager)
### 3. Sync (Weave) — синхронизация данных через сервера Mozilla
### 4. Synced Tabs — вкладки с других устройств через Sync
### 5. WebChannel — веб-интеграция FxA

---

## Фаза 1: Отключение Firefox Accounts

### 1.1 Главный флаг

**Файл:** `browser/app/profile/firefox.js` (строка ~2309)

```js
// Было:
pref("identity.fxaccounts.enabled", true);
// Стало:
pref("identity.fxaccounts.enabled", false);
```

Это единственное изменение, которое тянет за собой большую часть отключения:
- `updateFxaToolbarMenu()` в `browser.js` проверяет этот флаг и скрывает кнопку FxA
- `gSync.init()` в `browser-sync.js` выходит сразу если флаг false
- `CustomizableWidgets.sys.mjs` не регистрирует FxA-виджет если флаг false
- FirefoxView скрывает секцию синхронизации

### 1.2 Отключить тулбар-кнопку FxA

**Файл:** `browser/app/profile/firefox.js`

```js
pref("identity.fxaccounts.toolbar.enabled", false);
```

### 1.3 Убрать gSync.init() из idle задач (опционально, для чистоты)

**Файл:** `browser/base/content/browser-init.js` (~строка 972)

Удалить блок:
```js
scheduleIdleTask(() => {
  gSync.init();
});
```

Это избегает инициализации всего `browser-sync.js`, подписки на observers и т.д.
**Важно:** если убирать — нужно также проверить, что `gSync` не вызывается где-то ещё при инициализации окна.

---

## Фаза 2: Отключение менеджера паролей Mozilla

Менеджер паролей интегрирован на двух уровнях: backend (хранение) и frontend (UI подсказки, автозаполнение).

### 2.1 Отключить захват и автозаполнение

**Файл:** `modules/libpref/init/all.js` или `browser/app/profile/firefox.js`

```js
pref("signon.rememberSignons", false);
pref("signon.autofillForms", false);
pref("signon.generation.enabled", false);
pref("signon.formlessCapture.enabled", false);
pref("signon.formRemovalCapture.enabled", false);
pref("signon.capture.inputChanges.enabled", false);
```

`signon.rememberSignons = false` — главный выключатель. При нём `LoginManagerParent` не будет предлагать сохранить пароли и не будет автозаполнять.

### 2.2 Альтернатива: подключить собственный backend

Если нужно хранить пароли в собственном хранилище (а не отключить вообще):

1. Реализовать XPCOM-компонент, имплементирующий `nsILoginManagerStorage`
2. Зарегистрировать его с CID `@mozilla.org/login-manager/storage/...`
3. Установить `signon.storeSignons = true`, `signon.storage.provider = "custom"`

Это сложный путь — рекомендуется на более поздней стадии.

---

## Фаза 3: Отключение Sync (Weave)

Sync не запускается без FxA-аккаунта, поэтому Фаза 1 уже де-факто его отключает. Для полной чистоты:

### 3.1 Отключить все движки синхронизации

**Файл:** `browser/app/profile/firefox.js`

```js
pref("services.sync.engine.addons", false);
pref("services.sync.engine.bookmarks", false);
pref("services.sync.engine.history", false);
pref("services.sync.engine.passwords", false);
pref("services.sync.engine.prefs", false);
pref("services.sync.engine.tabs", false);
```

### 3.2 Убрать панель Synced Tabs из App Menu (опционально)

**Файл:** `browser/base/content/appmenu-viewcache.inc.xhtml`

Удалить или закомментировать блок `id="PanelUI-remotetabs"`.

Также скрыть точку входа в меню:

**Файл:** `browser/base/content/appmenu.inc.xhtml` (или аналогичный)

Найти и удалить/скрыть `toolbarbutton` или `toolbarmenuitem` с `id="sync-setup"` и `id="appMenu-remote-tabs-button"`.

---

## Фаза 4: Отключение FxA WebChannel

FxA WebChannel позволяет веб-страницам на `accounts.firefox.com` общаться с браузером (SSO, передача токенов).

**Файл:** `browser/base/content/browser-sync.js`

Найти `EnsureFxAccountsWebChannel()` (вызывается из `gSync.init()`). При отключении `gSync.init()` в Фазе 1 этого достаточно.

Если нужно явно: добавить ранний `return` в начало `EnsureFxAccountsWebChannel` или не вызывать её.

---

## Фаза 5: Реализация собственных функций вместо Mozilla

### 5.1 Синхронизация вкладок (замена Synced Tabs)

Архитектура на основе имеющегося WebSocket:

1. На сервере хранить список открытых вкладок для каждого устройства
2. Клиент при изменении вкладок отправляет через WebSocket сообщение `{ type: "tabs_update", tabs: [...] }`
3. Сервер рассылает актуальный список вкладок всем устройствам пользователя
4. В браузере создать компонент (аналог `SyncedTabsDeckComponent`) который:
   - Подписывается на сообщение `tabs_list` из WebSocket
   - Отображает вкладки других устройств в боковой панели или App Menu

Ключевые места для хука на изменение вкладок:
- `gBrowser` events: `TabOpen`, `TabClose`, `TabMove` в `browser.js`
- Или через `TabsProgressListener` в `browser-init.js`

### 5.2 Синхронизация настроек и закладок (замена Sync engines)

1. Реализовать модуль `VentoSync.sys.mjs` аналогично `VentoWebSocket.sys.mjs`
2. При получении `auth_ok` от WebSocket — запустить первичную синхронизацию
3. Использовать `PlacesUtils` (API закладок) и `Services.prefs` для чтения/записи данных
4. Передавать дельты изменений через WebSocket в формате `{ type: "sync", data: {...} }`

### 5.3 Хранение паролей в собственном хранилище

Если нужно хранить пароли:
1. Добавить API endpoints на сервере: `GET/POST /api/credentials`
2. Создать модуль `VentoCredentials.sys.mjs`, реализующий интерфейс nsILoginManagerStorage
3. Зарегистрировать в `browser/components/moz.build`

---

## Фаза 6: Cleanup UI

Убрать мёртвые UI-элементы, которые ссылаются на отключённую инфраструктуру:

### Из navigator-toolbox.inc.xhtml (или appmenu.inc.xhtml):
- FxA-кнопка: `id="fxa-toolbar-menu-button"` или `id="appMenu-fxa-status2"`
- Sync status: элементы с атрибутом `fxatoolbarmenu`

### Из browser/components/preferences/:
- Секция Sync (вкладка "Sync" в настройках Firefox)
- Скрыть через `hidden="true"` или удалить `<syncPane>` в `preferences.xhtml`

### Из FirefoxView:
- Убрать секцию Synced Tabs если не используется собственная реализация

---

## Порядок реализации (приоритеты)

| # | Действие | Файл | Сложность |
|---|----------|------|-----------|
| 1 | `identity.fxaccounts.enabled = false` | `browser/app/profile/firefox.js` | Минимальная |
| 2 | Отключить `signon.rememberSignons` и связанные | `browser/app/profile/firefox.js` | Минимальная |
| 3 | Отключить все `services.sync.engine.*` | `browser/app/profile/firefox.js` | Минимальная |
| 4 | Удалить `gSync.init()` из idle задач | `browser/base/content/browser-init.js` | Малая |
| 5 | Скрыть/удалить FxA и Sync UI из App Menu | appmenu-viewcache.inc.xhtml | Средняя |
| 6 | Реализовать синхронизацию вкладок через WebSocket | Новый VentoSync.sys.mjs | Большая |
| 7 | Реализовать синхронизацию закладок/настроек | Новый VentoSync.sys.mjs | Большая |
| 8 | Собственное хранилище паролей | Новый VentoCredentials.sys.mjs | Большая |

---

## Важные технические замечания

**Сборка:** При изменении только JS/HTML/CSS использовать `./mach build faster`. При добавлении новых `.sys.mjs` файлов — обязательно добавить в `moz.build` соответствующего каталога, иначе файл не будет упакован.

**Preferences:** Изменения дефолтов в `browser/app/profile/firefox.js` применяются только для новых профилей или если пользователь не менял пресет вручную. Для принудительного применения — использовать `Services.prefs.lockPref()` (нельзя изменить пользователем) или `defaultPrefs` через `autoconfig`.

**Тестирование отключения FxA:** После `identity.fxaccounts.enabled = false` в браузере не должно быть кнопки FxA в тулбаре, секции Sync в настройках. В `about:sync-log` всё должно быть пусто.

**WebChannel:** Если остаются страницы, которые пытаются общаться с FxA WebChannel, они будут получать тишину — это нормально, ошибок в консоли быть не должно при правильном отключении.
