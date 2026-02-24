# План: Маршрутизация всего трафика Firefox через VPN/Proxy

Цель: исключить возможность прохождения любого байта трафика мимо заданного прокси-сервера.
Это включает HTTP, HTTPS, WebSocket, WebTransport, DNS, WebRTC и прочие каналы.

---

## Архитектура сетевого стека Firefox

```
Сетевой запрос (HTTP, WebSocket, DNS, ...)
        │
        ▼
nsHttpChannel::ResolveProxy()          ← точка входа для HTTP/HTTPS
        │
        ▼
nsProtocolProxyService::asyncResolve() ← центральный сервис выбора прокси
        │
        ├── nsIProtocolProxyFilter     ← фильтры (extensible, позиция 0 = высший приоритет)
        │
        ├── PAC-скрипт (nsPACMan)      ← если сконфигурирован PAC
        │
        └── CanUseProxy()             ← проверка bypass-списка (!!!)
                │
                ▼
        nsProxyInfo (тип, хост, порт)
                │
                ▼
nsHttpConnectionInfo                  ← параметры соединения (включает ProxyInfo)
                │
                ▼
nsISocketTransportService::createTransport()  ← создание сокета
                │
        ┌───────┴────────┐
        ▼                ▼
nsSOCKSIOLayer        HTTP CONNECT
(SOCKS4/5)            (туннель для HTTPS)
        │
        ▼
nsDNSService           ← разрешение DNS (может утечь, если не через прокси!)
        │
        ▼
  Физический сокет
```

---

## 1. Центральный сервис прокси — `nsProtocolProxyService`

**Файлы:**
- [netwerk/base/nsProtocolProxyService.h](netwerk/base/nsProtocolProxyService.h)
- [netwerk/base/nsProtocolProxyService.cpp](netwerk/base/nsProtocolProxyService.cpp)

### 1.1 Отключить обход прокси для localhost/loopback

Метод `CanUseProxy()` содержит жёсткую логику обхода прокси для:
- loopback-адресов (127.0.0.1, ::1)
- plain-hostname (без точек) — контролируется `mFilterLocalHosts`
- списка исключений `network.proxy.no_proxies_on`

**Что изменить:**
- Убрать проверку loopback в `CanUseProxy()` (или сделать её управляемой через pref)
- Установить `mFilterLocalHosts = false` по умолчанию
- Либо добавить pref `network.proxy.force_all_traffic = true`, который полностью отключает
  все пути обхода и всегда возвращает `true` из `CanUseProxy()`

### 1.2 Отключить fallback на прямое соединение

Настройка `network.proxy.failover_direct` разрешает Firefox переключаться на прямое
соединение при недоступности прокси. Это необходимо **запретить**:
- В `nsProtocolProxyService::PrefsChanged()` жёстко зафиксировать `mFailoverToDirect = false`
- Или добавить kill-switch в логику выбора следующего прокси в цепочке `mNext`

---

## 2. Bypass-список — `CanUseProxy()` и `LoadHostFilters()`

**Файл:** [netwerk/base/nsProtocolProxyService.cpp](netwerk/base/nsProtocolProxyService.cpp)

Метод `LoadHostFilters()` загружает `network.proxy.no_proxies_on` — список хостов/IP,
для которых прокси не используется.

**Что изменить:**
- При включённом "force proxy" режиме полностью игнорировать `mHostFiltersArray`
- Добавить pref `network.proxy.ignore_bypass_list = true`
- В `CanUseProxy()`: если указанный pref активен — сразу возвращать `true` без проверок

---

## 3. Принудительная установка прокси через `nsIProtocolProxyFilter`

**Интерфейс:** [netwerk/base/nsIProtocolProxyFilter.idl](netwerk/base/nsIProtocolProxyFilter.idl)

Самый чистый способ перехвата — зарегистрировать фильтр с приоритетом 0 (наивысший),
который всегда возвращает заданный ProxyInfo независимо от результата PAC или настроек.

**Что изменить/добавить:**
- Реализовать `nsIProtocolProxyFilter` (или `nsIProtocolProxyChannelFilter`), который
  принудительно заменяет любой ProxyInfo на целевой (SOCKS5/HTTP)
- Зарегистрировать его как XPCOM-компонент с позицией 0
- Добавить его в [netwerk/base/](netwerk/base/) как `nsForcedProxyFilter.h/.cpp`

---

## 4. DNS — предотвращение утечки

**Файлы:**
- [netwerk/dns/nsDNSService2.h](netwerk/dns/nsDNSService2.h)
- [netwerk/dns/nsDNSService2.cpp](netwerk/dns/nsDNSService2.cpp)

DNS-запросы могут уходить напрямую, минуя прокси, что раскрывает список посещаемых сайтов.

### 4.1 SOCKS Remote DNS

Для SOCKS5 включить флаг `TRANSPARENT_PROXY_RESOLVES_HOST`:
- **Preference:** `network.proxy.socks_remote_dns = true`
- Это заставляет отправлять имя хоста на прокси, а не разрешать его локально
- Проверить, что флаг корректно выставляется в [netwerk/base/nsProxyInfo.h](netwerk/base/nsProxyInfo.h)

### 4.2 TRR (DNS-over-HTTPS)

Если используется TRR, убедиться что он тоже идёт через прокси:
- **Prefs:** `network.trr.mode`, `network.trr.uri`
- TRR-запросы создаются как обычные HTTP-запросы — они должны проходить через тот же
  `nsProtocolProxyService`, но требуется проверка в коде

### 4.3 Заблокировать нативный DNS-резолвер

В `nsDNSService::AsyncResolveInternal()`: если включён force-proxy режим и тип прокси
поддерживает remote DNS — блокировать локальные DNS-запросы и возвращать ошибку.

---

## 5. WebRTC — предотвращение IP-утечки

**Путь:** [media/webrtc/](media/webrtc/)

WebRTC использует собственный сетевой стек (libwebrtc) и **по умолчанию обходит** системный
прокси. Через ICE-кандидатов может раскрыть реальный IP.

### 5.1 Ограничить ICE-кандидатов

**Preference:** `media.peerconnection.ice.default_address_only = true`
- Ограничивает ICE только одним интерфейсом (не раскрывает локальные IP)

**Preference:** `media.peerconnection.ice.no_host = true`
- Полностью запрещает host ICE кандидатов

### 5.2 Принудительно использовать SOCKS для WebRTC

- **Файл:** [dom/media/webrtc/jsapi/PeerConnectionImpl.cpp](dom/media/webrtc/jsapi/PeerConnectionImpl.cpp)
- В методе создания ICE-агента передавать SOCKS-прокси из `nsProtocolProxyService`
- Libwebrtc поддерживает SOCKS5 через `rtc::ProxyInfo`

### 5.3 Запретить WebRTC полностью (крайний вариант)

**Preference:** `media.peerconnection.enabled = false`

---

## 6. HTTP-канал — `nsHttpChannel`

**Файл:** [netwerk/protocol/http/nsHttpChannel.cpp](netwerk/protocol/http/nsHttpChannel.cpp)

Метод `ResolveProxy()` (~строка 4292) — точка входа для определения прокси для каждого
HTTP-запроса. Здесь нет отдельной логики обхода, но важно убедиться, что:
- Прокси-резолвер не возвращает `DIRECT` для любого запроса
- В случае ошибки соединения через прокси запрос **не** ретраится напрямую

**Что проверить:**
- `nsHttpChannel::OnProxyAvailable()` — не допустить fallback на `DIRECT`
- `nsHttpConnectionInfo` — проверить хранение `mProxyInfo` и признаки `mUsingHttpProxy`

---

## 7. Настройки конфигурации прокси

**Preference:** `network.proxy.type`
- `0` = DIRECT (прямое соединение — **запрещено**)
- `1` = MANUAL (ручная настройка — нужный режим)
- `2` = PAC (автоматическая конфигурация через PAC)
- `4` = WPAD (автообнаружение)
- `5` = SYSTEM (системные настройки)

**Критические настройки для форсированного режима:**
```
network.proxy.type = 1  (или 2 с PAC-скриптом)
network.proxy.socks = <proxy-host>
network.proxy.socks_port = <proxy-port>
network.proxy.socks_version = 5
network.proxy.socks_remote_dns = true
network.proxy.no_proxies_on = ""   (пустой bypass-список)
network.proxy.failover_direct = false
media.peerconnection.ice.no_host = true
media.peerconnection.ice.default_address_only = true
```

---

## 8. Сокетный транспорт — `nsSocketTransportService`

**Файлы:**
- [netwerk/base/nsSocketTransportService2.h](netwerk/base/nsSocketTransportService2.h)
- [netwerk/base/nsSocketTransportService2.cpp](netwerk/base/nsSocketTransportService2.cpp)
- [netwerk/base/nsISocketTransportService.idl](netwerk/base/nsISocketTransportService.idl)

Метод `createTransport()` создаёт сокет с учётом `nsIProxyInfo`. Это последний уровень,
где можно перехватить создание соединения.

**Что проверить/изменить:**
- Если `aProxyInfo == nullptr` или `aProxyInfo->Type() == "direct"` — блокировать создание
  сокета в force-proxy режиме
- Добавить assertion/guard, который выбрасывает `NS_ERROR_NOT_AVAILABLE` при попытке
  создать прямое соединение

---

## 9. SOCKS-слой — `nsSOCKSIOLayer`

**Файл:** [netwerk/socket/nsSOCKSIOLayer.cpp](netwerk/socket/nsSOCKSIOLayer.cpp)

Реализует полный SOCKS4/5 handshake. Это финальная точка, где трафик уходит через прокси.

**Что проверить:**
- Корректность передачи имени хоста (а не IP) при `TRANSPARENT_PROXY_RESOLVES_HOST`
- Обработка ошибок аутентификации — не допустить fallback
- UDP Associate для UDP-трафика (если нужен)

---

## 10. WebTransport и HTTP/3 (QUIC)

**Путь:** [netwerk/protocol/webtransport/](netwerk/protocol/webtransport/)

HTTP/3 использует QUIC (UDP), который может обходить TCP-прокси. Если прокси не поддерживает
MASQUE (HTTP/3 proxy), то HTTP/3 нужно отключить.

**Preference:** `network.http.http3.enable = false`

Это заставит Firefox использовать HTTP/2 или HTTP/1.1 через TCP, которые корректно
туннелируются через SOCKS/HTTP-прокси.

---

## Приоритет изменений

| Приоритет | Область | Файл | Риск утечки |
|-----------|---------|------|-------------|
| 1 (критично) | Отключить bypass loopback | `nsProtocolProxyService.cpp` | Высокий |
| 2 (критично) | Отключить failover_direct | `nsProtocolProxyService.cpp` | Высокий |
| 3 (критично) | Remote DNS через SOCKS | `nsProxyInfo.h`, pref | Высокий |
| 4 (критично) | WebRTC IP leak | `PeerConnectionImpl.cpp`, prefs | Высокий |
| 5 (высокий) | Блокировка прямых сокетов | `nsSocketTransportService2.cpp` | Средний |
| 6 (высокий) | Отключить HTTP/3 (QUIC) | pref | Средний |
| 7 (средний) | ProxyFilter с приоритетом 0 | `nsForcedProxyFilter.h/.cpp` | Низкий |
| 8 (низкий) | TRR через прокси | `nsDNSService2.cpp` | Низкий |

---

## Структура файлов для новых изменений

```
netwerk/base/
├── nsProtocolProxyService.cpp   ← модифицировать CanUseProxy(), PrefsChanged()
├── nsProxyInfo.h                ← проверить флаги TRANSPARENT_PROXY_RESOLVES_HOST
├── nsForcedProxyFilter.h        ← новый файл: принудительный фильтр прокси
└── nsForcedProxyFilter.cpp      ← новый файл

netwerk/socket/
└── nsSOCKSIOLayer.cpp           ← проверить remote DNS, UDP

netwerk/base/
└── nsSocketTransportService2.cpp ← guard против прямых соединений

dom/media/webrtc/jsapi/
└── PeerConnectionImpl.cpp       ← передача SOCKS-прокси в ICE-агент
```
