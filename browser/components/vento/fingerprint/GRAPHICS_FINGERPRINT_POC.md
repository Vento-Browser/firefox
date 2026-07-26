# Графика (Canvas / WebGL / WebGPU / WebCodecs) — глубокий PoC (п.3)

Asana: https://app.asana.com/1/1216608809930980/project/1216609614088977/task/1216898066599166
Родитель (исследование, этап 1): `../../docs/FINGERPRINTING_RESEARCH.md` §3.

Это углублённый разбор §3 — самого «жирного» энтропийного канала и главного
вызова всей задачи. Цель PoC — **на реальном коде дерева** проверить, что даёт
включение существующих RFP-таргетов, где единственная обязательная нативная
врезка и, главное, **принять решение по стратегии: шум (а) vs софт-рендер (б)**.
Все ссылки на код ниже проверены в текущем дереве (`my_dev`). Реализация ядра —
`VentoGraphics.sys.mjs`, тест — `../../tests/unit/test_vento_graphics.js`
(запускается: `./mach test browser/components/tests/unit/test_vento_graphics.js`).

## TL;DR (вывод PoC)

Канал делится на **параметрические** поверхности и **readback**. Это принципиально
разные по цене вещи, и стратегия для них разная:

1. **Параметрические** (WebGL `getParameter`/лимиты + UNMASKED vendor/renderer,
   WebGPU лимиты/`isFallbackAdapter`/subgroup, WebCodecs configs) закрываются
   ровно как §6/§8 — **включением существующих RFP-таргетов** + двумя value-префами
   на vendor/renderer. Своего нативного патча им не нужно. Идентичность между
   машинами — 100%, тестируемо в CI.

2. **Readback** (`toDataURL`/`getImageData`, WebGL `readPixels`) — крайний случай.
   Firefox уже умеет солить readback шумом, НО ключ шума — **случайный UUID
   сессии** (`nsRFPService::GetBrowsingSessionKey`). Сделать ключ детерминированным
   из seed профиля — **единственная обязательная нативная врезка** во всём канале.
   Но её **недостаточно**: шум складывается поверх аппаратно-зависимого базового
   рендера, и не-зашумлённые биты базы всё равно текут.

**Вердикт по стратегии (реализован в `strategyVerdict()`): для readback выбран
путь (б) — унифицированный софт-рендер.** Только он устраняет расхождение базы у
источника и даёт 100%. Детерминированный seed-шум ложится сверху уже идентично.
Путь (а) (только шум) оставлен опцией: дёшево, без падения производительности, но
без гарантии 100%. Аппаратный рендер сохраняется для экранной отрисовки; софт-путь
форсируется только для readback.

Разбивка «что даёт таргеты+префы» / «что нужно патчить» — в `residualVariance()`.

---

## 1. Параметрические поверхности — закрываются таргетами (нативного патча нет)

### 1.1. WebGL UNMASKED vendor/renderer

Самая высокосигнальная строка канала. Прибивается двумя штатными префами (проверено
в `modules/libpref/init/StaticPrefList.yaml`):

- `webgl.override-unmasked-vendor` (DataMutexString)
- `webgl.override-unmasked-renderer` (DataMutexString)

`VentoGraphics.deterministicPrefs()` пишет туда `unmaskedVendor`/`unmaskedRenderer`
из профиля (дефолт — `Google Inc. (Intel)` / ANGLE Intel D3D11, совпадает с
`VentoFingerprintProfile.getSpoofedValues().gpuVendor/gpuRenderer`, чтобы весь
браузер сообщал одну GPU-идентичность). Дополнительно `overridesFragment()`
включает `WebGLRenderInfo`(60) + `WebGLVendorConstant`(78) +
`WebGLRendererConstant`(80) — RFP-санитизация UNMASKED на случай, если override-преф
пуст.

### 1.2. WebGL лимиты (`getParameter`)

`WebGLRenderCapability`(59) приводит перечисляемые лимиты к спецификационным
минимумам. `getSpoofedValues().webglParameters` — курируемый детерминированный
набор (MAX_TEXTURE_SIZE и т.п.), который сайт должен видеть флит-широко. Значения
важны не сами по себе, а тем, что они **константны на всех машинах**.

### 1.3. WebGPU и WebCodecs

- WebGPU: `WebGPULimits`(64), `WebGPUIsFallbackAdapter`(65),
  `WebGPUSubgroupSizes`(66) — зажимают форму адаптера. `getSpoofedValues().webgpu`.
- WebCodecs: `WebCodecs`(71) нормализует ответ `isConfigSupported`.
  `getSpoofedValues().webcodecs` — флит-широкий список кодеков.

Все три — deny/sanitize-by-default, нативного патча не требуют (та же механика, что
§6/§8).

---

## 2. Readback — единственная обязательная нативная врезка (ключ шума)

Механизм рандомизации canvas/WebGL в дереве (проверено в
`toolkit/components/resistfingerprinting/nsRFPService.cpp`):

```
nsRFPService::GetBrowsingSessionKey(attrs, &sessionKey)   // строка 1323
  -> mBrowsingSessionKeys.InsertOrUpdate(oaSuffix, nsID::GenerateUUID())  // 1361
nsRFPService::GenerateKey(channel)                        // строка 1396
  sessionKey = GetBrowsingSessionKey(...)
  key = HMAC_SHA256(sessionKey, partitionKey /* top-level site */)        // 1455+
nsRFPService::RandomizePixels(...)                        // строка 1841
  // добавляет детерминированный (по key) шум к RGBA-байтам readback
```

Ключевое наблюдение: **шум уже детерминирован по `key`**, а `key =
HMAC(sessionKey, site)`. То есть per-site партиционирование делает сам HMAC вниз по
потоку. **Единственная случайность — `sessionKey` = `nsID::GenerateUUID()`**.

**Врезка (одна строка семантически):** в `GetBrowsingSessionKey` вернуть nsID,
детерминированно выведенный из seed профиля, вместо `GenerateUUID()`. Эталон в JS —
`VentoGraphics.canvasSeedHex()` / `webglSeedHex()` (через
`VentoFingerprintProfile.surfaceSeedHex`, cyrb128). Поскольку site уже
подмешивается downstream HMAC-ом, на уровне session-key достаточно
seed(+oaSuffix); per-origin аргумент в `canvasSeedHex(origin)` — для случаев, когда
нативная сторона хочет солить сама. Нативная реализация обязана воспроизвести ту же
cyrb128-деривацию побайтово (см. README, «single most important injection point»).

Это делает шум **воспроизводимым между машинами**. Но не решает базу — см. §3.

---

## 3. Стратегия: (а) шум vs (б) софт-рендер — и почему выбран (б)

### 3.1. Почему одного детерминированного ключа недостаточно

`RandomizePixels` добавляет шум **поверх** байтов, полученных реальным рендером.
Даже с фиксированным ключом:

```
readback_hash = H( base_render(GPU, driver, OS)  +  noise(seed, site) )
```

`noise` теперь идентичен между машинами, но `base_render` — нет. Firefox шумит лишь
малую долю каналов/пикселей; не тронутые биты базы напрямую утекают в хэш. Значит
путь (а) — **шумовая маскировка поверх аппаратного рендера** — по построению не
даёт 100%: чтобы перекрыть аппаратную разницу, амплитуду/охват шума пришлось бы
задрать до видимого искажения. Годится как дешёвая эвристика, не как гарантия.

### 3.2. Путь (б): унифицировать базу софт-рендером

Если `base_render` сделать **программным и одинаковым на всех машинах**, то и хэш
одинаков (а seed-шум сверху остаётся идентичным). Реальные префы дерева (проверено
в `StaticPrefList.yaml`), которыми это форсируется для readback-пути:

- `gfx.canvas.accelerated=false` — софт-путь canvas 2D (вместо Skia/GPU);
- `webgl.forbid-hardware=true` — запрет аппаратного WebGL-бэкенда (падение на
  программный растеризатор / WARP);
- `gfx.webrender.software=true` — WebRender в софте.

Их пишет `VentoGraphics.deterministicPrefs()` при `softwareRender=true` (дефолт).
`softwareRender` в `DEFAULT_GRAPHICS_PROFILE` включён именно потому, что это
единственная конфигурация, дающая 100% идентичность readback.

### 3.3. Цена и как её ограничить (честные остатки)

`residualVariance()` перечисляет цену пути (б):

- **`readback-base-render-divergence`** — корневая причина; закрывается (б). Для
  кросс-ОС идентичности сам софт-растеризатор (SwiftShader/llvmpipe/WARP) должен
  быть **одним билдом на всех платформах** — это остаток уровня bundled-binary/сборки.
- **`software-render-cost`** — perf и визуальный паритет. Смягчение: **аппаратный
  рендер для экрана, софт — только на readback-пути** (`toDataURL`/`getImageData`/
  `readPixels`). Префы выше — грубый PoC-переключатель; продовая врезка должна быть
  readback-scoped, а не глобальным софт-свитчем.
- **`canvas-text-glyph-metrics`** — текст на canvas растеризует глифы, метрики
  которых аппаратно/бэкенд-зависимы. Тот же корень, что метрики глифов §4 (шрифты):
  общий детерминированный софт-растеризатор текста + вшитые бинарники шрифтов.
- **`cross-cpu-software-simd`** — даже единый софт-растер может расходиться в
  младших битах между SIMD-тирами CPU (как DSP-хэш аудио §5). Опция: seed-шум
  (`perturbPixels`), чья амплитуда доминирует младшие биты, либо скалярное ядро.

### 3.4. Эталон шума для нативного хука

`readbackNoise(length, surface, origin)` → `Int8Array` целочисленных дельт в
`[-CANVAS_NOISE_AMPLITUDE, +CANVAS_NOISE_AMPLITUDE]` на 8-битный RGBA-канал;
`perturbPixels(bytes, surface, origin)` — та же дельта, наложенная с клампом
[0,255]. Это побайтовый контракт, который нативный хук обязан воспроизвести, если
включён путь (а) или нужно домаскировать SIMD-остаток пути (б). Тот же паттерн, что
`VentoAudio.perturbSamples()` для DSP-хэша аудио.

---

## 4. Что проверяет тест (CI, детерминированно)

`test_vento_graphics.js` строит два независимых профиля из одних данных («две
машины») и проверяет:

- побайтовую идентичность `getSpoofedValues()`, `deterministicPrefs()`,
  `surfaceDescriptor()`, ключей `canvasSeedHex`/`webglSeedHex` и потоков
  `canvasNoise`/`webglNoise`;
- саму митигацию: все таргеты §3 присутствуют в `overridesFragment()`; vendor/
  renderer прибиты префами; при `softwareRender` выставлены три софт-префа (и
  отсутствуют при выключенном); вердикт стратегии = `b-for-readback-...`;
  readback-ключи canvas и webgl различны и per-origin; шум ограничен амплитудой;
  `injectionPoints()` явно называет `GetBrowsingSessionKey` как ядровую врезку;
  `residualVariance()` перечисляет `readback-base-render-divergence`.

**E2E (аппаратно-зависимо, вне CI):** снять `toDataURL`/`readPixels`-хэши на двух
физически разных стендах (разный GPU/ОС) при включённом `softwareRender` и
сравнить побайтово — единственный способ поймать утечку базы, которую unit-тест не
видит (см. `../README.md`, раздел E2E, `vento-test-env/fingerprint/`).
