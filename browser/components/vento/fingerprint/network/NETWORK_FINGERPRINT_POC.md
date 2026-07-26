# Сетевые/протокольные отпечатки — глубокий PoC (п.9)

Asana: https://app.asana.com/1/1216608809930980/project/1216609614088977/task/1216889447048100
Родитель (исследование, этап 1): `../../docs/FINGERPRINTING_RESEARCH.md` §9.

Это углублённый разбор блока §9 из общего исследования: TLS ClientHello (JA3/JA4),
HTTP/2 и HTTP/3 (Akamai h2), порядок HTTP-заголовков, IP/ASN. Задача PoC —
проверить **на реальном коде дерева**, что даёт единый билд Vento + `vento_proxy`
и что остаётся закрыть патчем NSS/ядра. Все ссылки на код ниже проверены в
текущем дереве (`my_dev`).

## TL;DR (вывод PoC)

**Внутри одного билда Vento сетевой отпечаток УЖЕ практически идентичен между
машинами.** Порядок cipher suites и расширений, supported_groups/key_share,
кадр HTTP/2 SETTINGS и его порядок, порядок псевдо- и обычных заголовков —
всё это зафиксировано скомпилированным кодом, а не ОС хоста. Между двумя
машинами на одном билде различается лишь небольшой **перечислимый** набор:

1. **per-connection рандом** — значения GREASE, наличие ECH-grease,
   вероятностные key share;
2. **per-host состояние** — кэш TLS-intolerance (даунгрейд версии по истории
   прошлых обломов рукопожатия);
3. **prefs**, которые могли быть изменены относительно дефолта билда.

Пункты (2), (3) и детерминируемая часть (1) закрываются **только префами**, без
нативного патча — это делает `VentoNetworkFingerprint.deterministicPrefs()`.
Неустранимый остаток — случайные байты GREASE (нормализуются самим JA4) и
TCP/IP-стек хоста — закрывается патчем NSS и, соответственно, прокси. Разбивка
«что даёт билд+прокси» / «что нужно патчить» — в `residualVariance()`.

---

## 1. TLS ClientHello (JA3/JA4)

### 1.1. Порядок расширений НЕ рандомизируется

В отличие от Chrome (который с 2023 перемешивает расширения ClientHello), NSS
шлёт расширения в **фиксированном порядке** — таблица отправителей в
`security/nss/lib/ssl/ssl3ext.c`, никакой permutation/shuffle в пути отправки нет
(проверено поиском по `security/nss/lib/ssl/`). Значит порядок расширений —
константа билда ⇒ одинаков на всех машинах Vento. Это ключевое отличие: JA4 для
Vento стабилен «из коробки».

### 1.2. GREASE — рандом на каждое соединение

`tls13_ClientSetupGrease()` (`security/nss/lib/ssl/tls13con.c:7484`) генерирует 8
GREASE-значений через `PK11_GenerateRandom` на КАЖДОЕ рукопожатие:

```c
PK11_GenerateRandom(random, sizeof(random));
grease->idx[i] = ((random[i] << 8) | random[i]);   // 0x?a?a
grease->pskKem = 0x0b + ((random[7] >> 5) * 0x1f);
```

Следствие: «сырой» JA3 (md5 списка расширений *с содержимым*) меняется на каждом
соединении у **любого** Firefox, не только между машинами. **JA4 сортирует и
выкидывает GREASE** (значения `0x?a?a`), поэтому JA4 этим не задет. Вывод:
- для JA4 — делать ничего не надо;
- для побайтово идентичного ClientHello (если он нужен) — засеять GREASE
  детерминированно из профиля. Точка врезки: `tls13_ClientSetupGrease` (см.
  `residualVariance().tls-grease-bytes`).

### 1.3. ECH-grease: присутствие расширения — вероятностное

`nsNSSIOLayer.cpp:1559` включает ECH-grease по монетке на каждое соединение:

```c
if ((RandomUint64() % 100) >= 100 - security.tls.ech_grease_probability) {
    SSL_EnableTls13GreaseEch(fd, PR_TRUE);
    SSL_SetTls13GreaseEchSize(fd, ech_grease_size);
}
```

То есть само НАЛИЧИЕ расширения ECH (0xfe0d) в ClientHello рандомно ⇒ список
расширений (а с ним JA3 и JA4-дайджест расширений) прыгает. Байты полезной
нагрузки greased-ECH тоже случайны, но JA3/JA4 хешируют *типы* расширений, а не
содержимое, поэтому достаточно зафиксировать присутствие. Правится префом:
`security.tls.ech_grease_probability` → 0 или 100 (модуль запрещает промежуточные
значения). Дефолт модуля — 100 (остаёмся в когорте «Firefox с ECH-grease»).

### 1.4. key_share / supported_groups: prefs + канал сборки

`nsNSSIOLayer.cpp:1578-1611` собирает named groups и число key share:

```c
additional_shares = security.tls.client_hello.send_p256_keyshare;  // @IS_NOT_NIGHTLY_BUILD@
if (security.tls.enable_kyber && tls13) { namedGroups += mlkem768x25519; additional_shares++; }
namedGroups += x25519, secp256r1, secp384r1, secp521r1, ffdhe2048, ffdhe3072;
if (security.tls.enable_mlkem1024 && tls13) namedGroups += mlkem1024;
SSL_SendAdditionalKeyShares(fd, additional_shares);
```

Проблемы для идентичности:
- `send_p256_keyshare` дефолтится в `@IS_NOT_NIGHTLY_BUILD@` — то есть **nightly и
  release отдают разное число key share**. Пинним префом.
- `enable_kyber` / `enable_mlkem1024` радикально меняют секцию key_share
  (post-quantum). Обязаны совпадать по всему флоту. Пинним.

Named groups перечислены статически в коде ⇒ порядок и состав — константа билда.

### 1.5. Версии и intolerance-даунгрейд

`security.tls.version.{min,max}` (дефолт 3..4 = TLS1.2..1.3). Но
`AdjustForTLSIntolerance()` (`nsNSSIOLayer.cpp:1517`) может понизить `range.max` и
добавить `TLS_FALLBACK_SCSV` по **per-host кэшу** прошлых обломов рукопожатия —
это зависит от истории конкретной машины. Нейтрализуется пином
`security.tls.version.fallback-limit` = `version.max`: тогда даунгрейд становится
no-op. Для железобетонной гарантии — дополнительно чистить IntoleranceStore на
старте (опциональный нативный хук).

---

## 2. HTTP/2 — Akamai fingerprint

Akamai h2 fingerprint = `SETTINGS | WINDOW_UPDATE | PRIORITY | порядок псевдо-заголовков`.

### 2.1. Кадр SETTINGS — фиксированный порядок, значения из констант/префов

`Http2Session::SendHello`/`GenerateSettings` (`Http2Session.cpp:1080-1155`) пишет
записи строго по возрастанию ID в жёстко заданном порядке:

| # | SETTINGS | Значение | Управляется |
|---|---|---|---|
| 1 | HEADER_TABLE_SIZE | `DefaultHpackBuffer()` | `network.http.http2.default-hpack-buffer` |
| 2 | ENABLE_PUSH | 0 | константа |
| 3 | MAX_CONCURRENT | 0 | опционально, `...send_push_max_concurrent_frame` |
| 4 | INITIAL_WINDOW | `mPushAllowance` | константа |
| 5 | MAX_FRAME_SIZE | `kMaxFrameData` | константа |
| 6 | NO_RFC7540_PRIORITIES | 0/1 | опц., `...send_NO_RFC7540_PRI` + `...enabled.deps` |

Порядок записей — в коде, не пренастраиваемый. Значения и *присутствие*
опциональных записей (#3, #6) пиннятся префами ⇒ кадр SETTINGS байт-в-байт
одинаков по флоту.

### 2.2. Порядок псевдо-заголовков

`Http2Compressor::EncodeHeaderBlock` (`Http2Compression.cpp:1037`) шлёт псевдо-
заголовки в порядке **`:method, :path, :authority, :scheme`** (для CONNECT —
`:method, :authority`). Это и есть Akamai pseudo-header order (`m,p,a,s`). Порядок
— константа билда. `TE: trailers` добавляется последним (можно подавить хаком
`moz_no_te_trailers`, но в обычном потоке он всегда есть).

Вывод: h2-отпечаток Vento детерминирован при пиннутых префах §2.1.

---

## 3. HTTP/3 (QUIC)

HTTP/3 (`network.http.http3.enable`) добавляет свой транспортный/QUIC-отпечаток и
влияет на поведение Alt-Svc. Само наличие/отсутствие HTTP/3 — уже сигнал, поэтому
пиннится префом по флоту. Детальный разбор QUIC transport parameters — вне рамок
этого PoC (тестируемость низкая, требует отдельного QUIC-стенда); фиксируем как
известный последующий пункт. Транспортный слой QUIC, как и TCP, в конечном счёте
нормализуется egress'ом прокси.

---

## 4. Порядок HTTP-заголовков

Порядок обычных заголовков запроса — это порядок вставки в `nsHttpHeaderArray`
(`nsHttpHandler::AddStandardHeaders` и последующие `SetHeader`), то есть **константа
кода**. Пренастраиваемого порядка нет и менять его не требуется — он уже одинаков.
Единственное, что различается, — **значение `Accept-Language`** (зависит от
локали, `nsHttpHandler.cpp:773-793`). Оно обязано совпадать с локалью визуального
профиля (`VentoFingerprintProfile.locale`), иначе TLS/h2 говорят «одна машина», а
заголовок — «другая». Это единственная точка сцепки сетевого профиля с визуальным;
пиннится `intl.accept_languages`.

---

## 5. IP / ASN / гео и TCP/IP-стек

Ни один браузерный pref или патч NSS не выровняет IP-адрес, ASN, страну и
low-level TCP/IP-отпечаток (TTL/hop-limit, initial window, MSS, window scale, TCP
timestamps) — их формирует ядро ОС хоста. Это закрывается **исключительно
`vento_proxy`**: origin-сервер видит SYN и IP прокси, а не клиента, поэтому
транспортный отпечаток и гео/ASN — это отпечаток прокси, одинаковый для всех
клиентов Vento за одним egress. Отсюда два требования:
- прокси обязателен для §9 (иначе IP/TCP выдают разные машины);
- TZ/локаль профиля должны соответствовать гео прокси, иначе появляется
  внутреннее противоречие (само по себе отпечаток).

---

## 6. Итоговая матрица «билд+прокси vs патч»

| Канал | Состояние на одном билде | Действие |
|---|---|---|
| Порядок расширений/cipher TLS | константа билда, идентичен | — |
| supported_groups/key_share | prefs (p256/kyber/mlkem) | пин префами |
| Версии TLS + intolerance-даунгрейд | per-host state | пин `fallback-limit` (+опц. чистка кэша) |
| ECH-grease presence | per-connection рандом | пин `ech_grease_probability` 0/100 |
| GREASE значения | per-connection рандом | JA4: не нужно; raw JA3: **патч NSS** `tls13_ClientSetupGrease` |
| HTTP/2 SETTINGS (значения+порядок) | порядок в коде, значения prefs | пин префами |
| Порядок псевдо-/обычных заголовков | константа кода | — |
| Accept-Language | локаль | пин под визуальный профиль |
| HTTP/3 presence | pref | пин префом |
| IP/ASN/гео + TCP/IP-стек | ОС хоста | **только `vento_proxy`** |

**Требует нативного патча ровно один пункт** (и то лишь если нужен побайтовый
raw-JA3, а не JA4): детерминированный GREASE в NSS. Всё остальное закрывается
префами (`deterministicPrefs()`) + прокси. Это и есть ответ PoC.

---

## 7. Как это изолировано (требование Gleb)

- `VentoNetworkFingerprint.sys.mjs` — чистый JS, без зависимостей от Firefox:
  профиль → детерминированная карта префов (`deterministicPrefs()`) + честный
  список неустранимого остатка с точками врезки (`residualVariance()`).
  Применение карты к `Services.prefs` — единственная строчка сцепки с ядром и
  живёт в вызывающем коде (Vento-панель/BrowserGlue), не в модуле.
- Единственная **нативная** точка врезки для §9 — `tls13_ClientSetupGrease` в
  NSS (опциональна, только для raw-JA3). Задокументирована здесь и в
  `residualVariance()`, чтобы её можно было вынести отдельным патчем.
- Тест: `browser/components/tests/unit/test_vento_network_fingerprint.js`
  (детерминизм карты префов «две машины», согласованность `wireDescriptor` и
  `residualVariance` с матрицей).

## 8. Как измерять (низкая тестируемость — нужен стенд)

Юнит-тест проверяет только детерминизм КОНФИГА. Реальный JA3/JA4/h2 читается лишь
с провода, поэтому есть стенд `vento-test-env/fingerprint/network/`:
`capture.py` (локальный TLS/h2-сервер, снимает JA4 + Akamai h2 из ClientHello и
кадра SETTINGS реального билда) + `compare.mjs` (сверяет снимки двух машин: JA4 и
h2 обязаны совпадать, raw-JA3 — информационно, т.к. GREASE плавает до NSS-патча).
См. `vento-test-env/fingerprint/network/README.md`.
