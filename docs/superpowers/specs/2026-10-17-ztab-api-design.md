# ZTab: API (`api/`, NestJS + PostgreSQL)

Дата: 2026-10-17. Статус: чернетка на рев'ю.

**Зміни після реалізації.** Цей документ приведено у відповідність до зібраного коду:
- Код помилки `internal` для `500` (без деталей). Watcher `401`/`403` (хибний `WATCHER_TOKEN` у самого API) → `503 watcher_unavailable`, не проксується.
- `status_facts: null` означає «невідомо» (немає даних watcher для цього індексу), а не «нічого не сплачено». У відповіді для учасника є поле `participant_index`.
- `stale` = `true`, коли watcher недоступний АБО сам watcher повідомляє `stale` (віддає останні відомі факти, коли lightwalletd недоступний); висоти при цьому є, якщо є відповідь watcher.
- Повтор `PUT /tabs/{id}` (рядок уже існує) вимагає `Authorization: Bearer <admin token>` і ідентичного набору хешів токенів; інакше `409 conflict`.
- Ліміти рахуються за IP клієнта; бюджет створення прив'язано до обробника (не до URL). Змінні середовища `RATE_LIMIT_CREATE_PER_HOUR` (10) і `RATE_LIMIT_DEFAULT_PER_MINUTE` (120).
- Валідація `recipient_address` і `pczt_b64` (див. §6), щоб поля поза `Authorization` не могли нести секрет.
- Адреси від watcher при створенні перевіряються (кількість, індекси `0..n-1`, префікс мережі), інакше `503 watcher_unavailable` і нічого не зберігається.
- API сам повертає `active: true` у watcher, якщо `GET` показує `active: false` при `paused = false` (самовідновлення, best effort); cron архівування перевіряє також таби з кешованим станом `sweeping`.

Контекст: концепт-документ у корені репозиторію; watcher-spec (`2026-10-15-ztab-watcher-design.md`, §3 доменна модель, §6 контракт watcher ↔ API, §7 мінімум контракту API ↔ PWA); crypto-spec (`2026-10-16-ztab-crypto-design.md`, §4 ключі й блоби); скіл `.claude/skills/ztab-zcash-stack` (інваріанти приватності, таймінги). Цей spec не повторює їх, а посилається.

## 1. Мета і межі

Підпроєкт 3 за watcher-spec §2: єдиний сервіс, з яким говорить PWA. Він зберігає зашифровані блоби табів, пересилає запити до watcher, видає кожному посиланню лише його зріз даних і стежить за життєвим циклом табів, якими ніхто не користується.

Критерій успіху: PWA може створити таб, отримати адреси учасників, опитувати статуси, закрити таб через PCZT, і все це працює на одному VPS у Docker Compose поруч із watcher, нодою і базою; учасник в індивідуальному режимі не може дізнатися чужі суми; таби, покинуті на 7 днів, перестають навантажувати систему й оживають при першому ж відкритті посилання.

**Не входить:** push до браузера (SSE/WebSocket) — полінг свідомо, див. §6; редагування табу після створення (режим і склад учасників незмінні, як у watcher-spec §4); акаунти, реєстрація, код для суддів (демо відкрите для всіх); Docker Compose і reverse proxy для VPS — їх описує інфра-підпроєкт, тут лише вимоги до API (§10); аналітика і будь-які сторонні сервіси.

## 2. Рішення, ухвалені з Віталієм

1. **Хостинг:** один VPS, усе в Docker Compose: Zebra, lightwalletd, watcher, API, PostgreSQL, PWA як статика за reverse proxy з HTTPS. API говорить з watcher по внутрішній мережі Compose з Bearer-токеном, без TLS між ними.
2. **Токени доступу:** учасник в індивідуальному режимі не повинен бачити чужих сум. З секрету кожного посилання виводиться токен, API зберігає хеші і віддає зріз за роллю (§4).
3. **Відкрите демо:** таби може створювати будь-хто, без коду для суддів; захист лише лімітами (§8).
4. **Архівування:** таб без запитів 7 днів стає `abandoned`, watcher перестає його опитувати й розшифровувати мемпул для нього; перший запит оживляє (§7).
5. **Полінг, не push** (§6).

Решта рішень у цьому документі мої (стек, формати, числа); їх можна змінити без перегляду пунктів вище.

## 3. Стек і структура

- `api/` у pnpm-workspace поруч із `crypto/`. NestJS 12 на Node 24, TypeScript 5.9, Prisma 7 з `@prisma/adapter-pg`, PostgreSQL 16, валідація тіл через zod 4, `@nestjs/throttler` для лімітів. Тести Jest (стандарт NestJS).
- Модулі NestJS: `tabs` (створення, читання, життєвий цикл), `sweep` (закриття, проксі до watcher), `watcher` (HTTP-клієнт з кешем), `auth` (розбір токена і роль), `status`, `lifecycle` (cron). Prisma-схема в `api/prisma/schema.prisma`, міграції в репозиторії.
- `@ztab/crypto` отримує невелику TypeScript-доробку (без перезбірки WASM): `deriveTabKeys` додатково повертає токени, плюс `hashToken` (SHA-256 через `crypto.subtle`) і `encodeToken` (base64url). Ця доробка частина підпроєкту.
- Watcher отримує два ендпоінти (§7), теж частина підпроєкту.

Змінні оточення API: `DATABASE_URL`, `WATCHER_URL` (у Compose `http://watcher:8080`), `WATCHER_TOKEN` (значення `ZTAB_API_TOKEN` watcher), `ZTAB_NETWORK` (`test` | `main`, лише для `/status` і валідації), `CORS_ORIGIN` (origin PWA), `PORT`. Жодних значень за замовчуванням для секретів: без `WATCHER_TOKEN` і `DATABASE_URL` сервіс не стартує.

## 4. Доступ: токени і ролі

Секрет кожного посилання (crypto-spec §4): `master` в адмін-посиланні, `group_key` у груповому, `participant_key[i]` в індивідуальному. З нього браузер виводить токен:

`token = HKDF-SHA256(secret, salt = tab_id як UTF-8, info = "ztab/v1/token")`, 32 байти.

- При створенні табу браузер Аліси надсилає `token_hashes`: SHA-256 кожного токена у hex: `admin` завжди, `group` у режимі `group`, `participants[i]` у режимі `individual`. Самі токени на сервер не потрапляють.
- Кожен запит до табу, крім `PUT`, несе `Authorization: Bearer <base64url(token)>`. API хешує, шукає хеш серед токенів цього табу і визначає роль: `admin`, `group` або `participant(i)`.
- Зріз за роллю: `admin` і `group` бачать усіх учасників (адреси, платежі, факти) і свій блоб; `participant(i)` бачить лише свій блоб, свою адресу і свої факти. `POST /sweep`, `POST /broadcast`, `GET /sweep` лише для `admin`.
- Відсутній токен → `401`. Невідомий таб або токен, який не належить табу → `404` з однаковим тілом, щоб не підтверджувати існування табу. Правильний токен не тієї ролі (учасник викликає `sweep`) → `403`.
- Порівняння хешів через `crypto.timingSafeEqual` після пошуку за індексом у базі. Хеш ніколи не логується.

## 5. Дані (PostgreSQL)

- `tabs`: `id uuid pk` (генерує браузер), `mode` (`group` | `individual`), `participants_count int`, `ufvk text`, `birthday int`, `network text`, `paused bool default false`, `last_known_state text` (`open` одразу після створення; оновлюється при кожній успішній відповіді watcher), `last_known_at`, `created_at`, `last_access_at`, `closed_at nullable`.
- `tab_addresses`: `tab_id`, `index int`, `address text`, pk `(tab_id, index)`. Копія того, що watcher віддав при реєстрації, щоб `GET` працював і без watcher.
- `tab_blobs`: `tab_id`, `role` (`admin` | `group` | `participant`), `index int nullable`, `ciphertext bytea`, unique `(tab_id, role, index)`.
- `tab_tokens`: `tab_id`, `role`, `index int nullable`, `token_hash bytea(32)`, unique `(token_hash)`.

API не зберігає суми, статуси, txid, імена. Усе про платежі приходить від watcher на вимогу. Стан табу (`open` | `sweeping` | `closed`) належить watcher; `last_known_state` це лише кеш для відповіді, коли watcher недоступний. API додає `abandoned` як похідний від `paused`. Термінальний `abandoned` у самому watcher (існує в його моделі, ніде не ставиться) API не використовує і не оживляє: якщо watcher його колись віддасть, він проходить у `state` як є.

## 6. HTTP-контракт API ↔ PWA

JSON, `snake_case`, суми в zatoshi цілими, час у RFC 3339 UTC. Помилки: `{ "error": { "code": "<snake_case>", "message": "<для людини>" } }`, коди `validation`, `not_found`, `unauthorized`, `forbidden`, `conflict`, `rate_limited`, `watcher_unavailable`, `watcher_rejected`, `internal` (`500`, без деталей).

| Метод і шлях | Токен | Тіло | Відповідь |
|---|---|---|---|
| `PUT /tabs/{tab_id}` | ні | `{mode, participants_count, ufvk, birthday, blobs: {admin, group?, participants?[]}, token_hashes: {admin, group?, participants?[]}}`, блоби base64, хеші hex | `201 {tab_id, addresses: [{index, address}]}`; повтор (рядок існує): потрібен `Authorization: Bearer <admin token>`, той самий `ufvk`, `mode`, `participants_count`, `birthday` і ідентичний набір `token_hashes` → `200` і блоби перезаписуються в одній транзакції (повтор після обриву); будь-яка розбіжність або відсутній/хибний токен → `409 conflict` |
| `GET /tabs/{tab_id}` | так | | `200 {tab_id, mode, participants_count, state, synced_height, tip_height, stale, role, blob, participants: [{index, address, payments: [Payment], status_facts}]}` (для `participant(i)` додається `participant_index`; `status_facts: null` = невідомо, немає даних watcher для цього індексу) — `blob` це блоб ролі (base64); `participants` для `participant(i)` містить один елемент; `state` ∈ `open | sweeping | closed | abandoned` |
| `POST /tabs/{tab_id}/sweep` | admin | `{recipient_address}` | проксі watcher `POST /v1/tabs/{id}/sweep`: `200 {pczt_b64, summary}`; `recipient_address` має починатися з префікса unified-адреси мережі (`utest1` для `test`, `u1` для `main`), до 512 символів, тому 32-байтовий секрет у це поле не пройде; помилки watcher за правилом нижче |
| `POST /tabs/{tab_id}/broadcast` | admin | `{pczt_b64}` | проксі: `200 {txid}`; `pczt_b64` від 256 до 49152 символів, base64url або стандартний base64 (`[A-Za-z0-9+/_-]`, `=` лише в кінці); помилки watcher за правилом нижче |
| `GET /tabs/{tab_id}/sweep` | admin | | проксі: `{state, txid, mined_height, confirmations}` |
| `GET /status` | ні | | `{network, tip_height, synced_height, lag_seconds, watcher: "ok" \| "stale" \| "down", block_interval_seconds}` |

**Помилки watcher** завжди загортаються у формат API, ніколи не проходять сирими: watcher `4xx` → той самий HTTP-статус, `code: "watcher_rejected"`, `message` дослівно з тіла watcher (`{"error": "<рядок>"}`), плюс поле `watcher_status`; watcher `5xx`, `502` (lightwalletd недоступний) і таймаут → `503`, `code: "watcher_unavailable"`; watcher `401`/`403` (хибний токен самого API) теж → `503 watcher_unavailable`. Виняток: watcher `409` на реєстрації (`tab_id` вже зареєстрований з іншим `ufvk`) → `409`, `code: "conflict"`. PWA розрізняє причини за `message` (це власний англійський текст watcher, наприклад `not synced yet` або `not every note has 10 confirmations`); машинні коди помилок у watcher відкладені на після хакатону.

`Payment` і `status_facts` рівно такі, як у watcher-spec §6. API не перераховує статуси, браузер робить це сам із `status_facts` і частки з блоба.

**Полінг замість push.** PWA опитує `GET /tabs/{id}` кожні 10 с (5 с на екрані учасника після натискання «Оплатити»). API ходить до watcher на вимогу і кешує відповідь `GET /v1/tabs/{id}` 5 с у пам'яті процесу; `POST /sweep` і `/broadcast` інвалідують кеш. Фонового опитування watcher немає. Обґрунтування: watcher сам не отримує push від ноди, тож SSE/WebSocket лише перенесли б те саме опитування на сервер, додавши стан з'єднань, перепідключення на мобільному, конфігурацію proxy і токен у query. Після хакатону, коли watcher отримає підписку на блоки, API зможе додати SSE поверх того самого `GET` без зміни контракту.

**`stale`** = `true`, коли watcher недоступний або сам повідомляє `stale: true` (останні відомі факти при недоступному lightwalletd; `synced_height`/`tip_height` у цьому разі присутні).

**Якщо watcher недоступний:** `GET /tabs/{id}` повертає `200` з даними з бази (блоб, адреси), `state` = `last_known_state` (або `abandoned`, якщо `paused`), порожніми `payments`, `status_facts: null`, `stale: true` і без `synced_height`/`tip_height`; `sweep`/`broadcast` → `503 watcher_unavailable`. Таймаут запиту до watcher 5 с, без retry (PWA і так повторить через 10 с).

## 7. Життєвий цикл табу

1. **Створення.** Валідація тіла; `participants_count` між 1 і 20; кількість блобів і хешів відповідає режиму; `ufvk` починається з `uview` для mainnet або `uviewtest` для testnet згідно з `ZTAB_NETWORK`. Потім `POST /v1/tabs` у watcher; якщо watcher відповів `422` (birthday старіший за tip − 1000) або помилкою, таб не створюється і тіло помилки watcher повертається PWA як `watcher_rejected`. Адреси від watcher перевіряються: рівно `participants_count` елементів, індекси `0..n-1` без дублів, кожна адреса з префіксом мережі (`utest1`/`u1`); інакше `503 watcher_unavailable` і нічого не зберігається. Успіх: одна транзакція в базі (tab, addresses, blobs, tokens).
2. **Активність.** Кожен автентифікований запит оновлює `last_access_at` (не частіше ніж раз на хвилину, щоб полінг не бив у базу).
3. **Архівування.** Cron раз на годину: таби з `paused = false`, стан watcher `open`, `last_access_at` старіший за 7 днів → `PUT /v1/tabs/{id}/active {active: false}` у watcher, `paused = true`. Кеш стану може застарівати, тому вибираються таби з кешованим `open` або `sweeping`, а фактичний стан перепитується в watcher; таби, які watcher досі веде як `sweeping`, не чіпаються, `closed` отримує `closed_at`.
4. **Оживлення.** Автентифікований запит до табу з `paused = true` → `PUT /v1/tabs/{id}/active {active: true}` у watcher, `paused = false`, далі звичайна обробка. Якщо watcher недоступний, запит обслуговується зі `stale: true`, а оживлення повториться наступного разу. Зворотний випадок: watcher відповів `active: false`, а `paused = false` → API викликає `setActive(true)` (best effort, помилка лише в лог із кодом).
5. **Видалення.** Cron раз на добу: таби, у яких watcher показує `closed` і `closed_at` старіший за 30 днів → видалити tab, addresses, blobs, tokens. `closed_at` ставиться, коли API вперше бачить `closed` від watcher. Watcher свої записи не видаляє, це його справа.

**Доробка watcher (частина цього підпроєкту):** `PUT /v1/tabs/{id}/active {active: bool}` з Bearer-токеном, ідемпотентно; `active = false` виключає таб із `open_tabs()` (мемпул-розшифрування, оновлення фактів, просування sweep), `active = true` повертає. Сканування блоків спільного `WalletDb` і далі пробує ключі всіх акаунтів, це властивість `zcash_client_sqlite` і зміні не підлягає; тобто «пауза» знімає навантаження з мемпулу й API, не з блок-скану. Повна архівація акаунту після хакатону. `GET /v1/tabs/{id}` для неактивного табу відповідає як зараз, з полем `active: false`.

## 8. Ліміти й захист від зловживань

- `PUT /tabs`: 10 за годину з однієї IP (за `X-Forwarded-For` від reverse proxy, довіряти лише йому). Усі інші маршрути: 120 за хвилину з IP. Бюджет створення прив'язано до обробника, а не до URL. Значення налаштовуються `RATE_LIMIT_CREATE_PER_HOUR` і `RATE_LIMIT_DEFAULT_PER_MINUTE` (цілі > 0).
- Тіло запиту до 64 КБ; кожен блоб до 16 КБ; `participants_count` ≤ 20.
- `helmet`, CORS лише для `CORS_ORIGIN`, без cookies.
- `GET /status` кешується 5 с, щоб сторінка статусу не била watcher.

## 9. Приватність і логи (обов'язкові інваріанти)

- API ніколи не логує тіла запитів і відповідей, заголовок `Authorization`, блоби, адреси, суми, txid, UFVK. Лог запиту: метод, шлях (з `tab_id`), статус, тривалість, помилковий код. Рівень `debug` вимкнений у продакшні.
- Блоби непрозорі: API не намагається їх розбирати і не зберігає нічого, що з них можна вивести.
- Фрагменти URL (`#a=`, `#g=`, `#p=`) ніколи не досягають API; будь-яке поле запиту, схоже на 32-байтний секрет у base64url поза `Authorization`, не приймається (валідатор).
- Відповідь на невідомий таб і на чужий токен однакова.
- `GET /status` не містить нічого про таби.
- Порушення будь-якого пункту це дискваліфікація на хакатоні; `reference/privacy-invariants.md` у скілі має пріоритет.

## 10. Розгортання і експлуатація

- `api/Dockerfile` багатоетапний: збірка в `node:24-alpine`, запуск як непривілейований користувач, `pnpm deploy` або `pnpm install --prod` для рантайму; `prisma migrate deploy` на старті контейнера, потім `node dist/main.js`.
- Health для оркестратора: `GET /healthz` (лише `200` і версія, без даних) окремо від `GET /status`.
- Compose, reverse proxy, TLS, мережі і томи описує інфра-підпроєкт; API вимагає від нього: приватну мережу до watcher і бази, `X-Forwarded-For`, HTTPS назовні, тайм-аут proxy не менше 15 с (sweep з доведенням займає ~2 с, запас).
- Graceful shutdown: SIGTERM закриває HTTP і Prisma.

## 11. Тестування

- **Unit (Jest):** розбір токена і ролі (усі три ролі, відсутній, чужий, не той таб, таймінг-безпечне порівняння), зріз відповіді за роллю на фікстурній відповіді watcher, валідація тіла `PUT` (режим ↔ кількість блобів і хешів, ліміти, формат `ufvk`), правила життєвого циклу (хто стає `abandoned`, хто видаляється), кеш 5 с, обробка відповідей watcher (`422`, `409`, таймаут).
- **Integration (Jest + справжній PostgreSQL із Docker + stub watcher):** stub це маленький HTTP-сервер у тесті з контрактом watcher-spec §6 (реєстрація повертає детерміновані адреси, `GET` повертає задані факти, `sweep` повертає фікстурну PCZT із `watcher/tests/fixtures/`). Сценарії: створення → читання кожною роллю → sweep адміном → broadcast; повтор `PUT`; `409`; watcher down → `stale: true`; архівування і оживлення (годинник підмінюється).
- **Контрактний тест з `@ztab/crypto`:** токени, виведені `deriveTabKeys` для фікстурного `master`/`tab_id` з `crypto/test/fixtures/hkdf.json`, дають хеші, які API приймає. Фіксує порт `ztab/v1/token` з обох боків.
- **Live (вручну, інфра-підпроєкт):** API проти справжнього watcher на тестнеті, сценарій з `watcher/tests/testnet_live.rs` повторюється через HTTP API.
- CI відкладений до інфра-підпроєкту (як і для `crypto/`).

## 12. Відкриті питання і ризики

- **Prisma 7 з `@prisma/adapter-pg` у NestJS 12**: нова зв'язка, перше завдання плану це скелет із міграцією і одним запитом, щоб ризик знявся в перший день.
- **`X-Forwarded-For` і ліміти**: без правильної конфігурації proxy всі запити матимуть одну IP і ліміт `PUT` вдарить по всіх суддях разом. Інфра-підпроєкт має це перевірити; API логує попередження, якщо заголовка немає.
- **Оживлення табу з великим відставанням**: після паузи watcher усе одно сканував блоки для всіх ключів, тож факти для оживленого табу актуальні; якщо після хакатону паузу зроблять повною архівацією, оживлення потребуватиме ресинку, і `stale` стане довшим.
- **Кеш у пам'яті процесу** не переживає рестарт і не ділиться між репліками; для одного контейнера це норма, для масштабування потрібен Redis, не в MVP.
