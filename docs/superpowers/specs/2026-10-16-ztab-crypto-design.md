# ZTab: crypto-модуль для браузера (`@ztab/crypto`)

Дата: 2026-10-16. Статус: чернетка на рев'ю.
Контекст: концепт-документ у корені репозиторію, spec watcher (`2026-10-15-ztab-watcher-design.md`, далі «watcher-spec»), скіл `.claude/skills/ztab-zcash-stack` (крейти, інваріанти приватності, рецепт WASM-збірки, правило підпису view-only PCZT). Цей spec не повторює факти зі скіла і watcher-spec, а посилається на них.

## 1. Мета і межі

Підпроєкт 2 за watcher-spec §2: модуль, який у браузері Аліси робить усе, що вимагає spending-матеріалу або Zcash-примітивів, і реалізує модель ключів із watcher-spec §4. Споживач один: PWA. API модуль не чіпає.

Критерій успіху: модуль збирається на stable Rust під `wasm32-unknown-unknown`; UFVK і адреси, виведені в браузері, збігаються з нативно виведеними для того самого seed; PCZT від реального watcher, підписана через `@ztab/crypto` у Node, потрапляє в блок на тестнеті (повтор `full_tab_lifecycle_on_testnet` з підписом через модуль).

Межа між WASM і WebCrypto, за результатами огляду екосистеми (WebZjs, Zafu/Zigner, Zcash Web Wallet, MetaMask browser-passworder): у WASM лише те, чого браузер не вміє, тобто Zcash-ключі, адреси, PCZT. HKDF-SHA256 і AES-256-GCM виконує `crypto.subtle` у TypeScript.

Свідомо не входить: синхронізація і мережа; proving (Prover лишається на watcher); транспарентні ключі; мнемоніка для `master` (резервна копія в MVP це адмін-посилання, PWA дає «скопіювати» і попередження); ZIP-321 (рядок формує PWA, крипто там немає); будь-яке зберігання ключів.

## 2. Структура пакета

Тека `crypto/` у pnpm-workspace, пакет `@ztab/crypto`. Репозиторій отримує `pnpm-workspace.yaml` і кореневий `package.json`; PWA і API підключатимуться як пакети.

- `crypto/rust/`: Rust-crate `ztab-crypto`, wasm-bindgen, без стану. Крейти з NU7-кохорту, піновані `=` як у `watcher/Cargo.toml`: `zcash_keys` (`orchard`), `zcash_address`, `zcash_protocol`, `pczt` (`signer`, `orchard`), `orchard`, `zip32`, `rand`. Без `zcash_client_backend`, без prover, без мережі, без логування. Ціль розміру модуля до 1.5 МБ.
- `crypto/pkg/`: результат збірки (`.wasm`, JS-glue, `.d.ts`). Комітиться, щоб PWA і тести не потребували Docker.
- `crypto/src/`: TypeScript-шар. Завантажувач WASM, HKDF і AES-GCM через `crypto.subtle`, кодування фрагментів посилань, типізовані обгортки.
- `crypto/build.sh`: Docker-збірка за рецептом зі скіла (`rust:1.98-bookworm`, clang, llvm-ar, `wasm-bindgen-cli` тієї самої версії, що пінована в `Cargo.toml`), результат у `pkg/`.

## 3. Інтерфейс Rust → WASM

Чисті функції, байти як `Uint8Array`, рядки як `string`, помилки як `Err(String)` з кодом на початку (`"invalid_pczt: <деталі>"`). `network` це `'test' | 'main'`. Rust-шар ніколи не отримує `master`: лише `spendSeed` і похідні.

| Функція | Вхід | Вихід |
|---|---|---|
| `deriveTabAccount(network, spendSeed)` | 32 байти | `{ ufvk: string, orchardSk: Uint8Array }`. `UnifiedSpendingKey::from_seed(network, spendSeed, AccountId::ZERO)`; `ufvk` = `usk.to_unified_full_viewing_key().encode(network)`; `orchardSk` = 32 байти Orchard spending key для `SpendAuthorizingKey` |
| `deriveAddress(network, ufvk, index)` | UFVK-рядок, `u32` | UA-рядок з єдиним Orchard-receiver: `ufvk.address(DiversifierIndex::from(index), UnifiedAddressRequest::custom(Require, Omit, Omit))`, той самий виклик, що у `watcher/src/wallet.rs::participant_addresses` |
| `validateRecipient(network, address)` | рядок | `Ok` або помилка `invalid_recipient`: не UA, немає shielded receiver, інша мережа, transparent або TEX. Те саме правило, що в watcher для `POST /sweep` |
| `inspectPczt(network, pcztBytes)` | байти | `{ outputs: [{ address: string, zat: number }], feeZat: number, totalInZat: number, txid: string \| null }`. Усі ненульові виходи Ironwood-бандла; комісія з балансу; `txid` лише для проведеної PCZT |
| `signPczt(network, pcztBytes, orchardSk, rngSeed, expected)` | PCZT, 32 байти ключа, 32 байти випадковості, `{ recipient: string, totalZat: number, feeZat: number }` | підписана PCZT (байти) або помилка |

`signPczt` перевіряє сам, не покладаючись на попередній `inspectPczt`: кожен ненульовий вихід іде на `expected.recipient` (порівняння декодованих receiver'ів, не рядків), сума ненульових виходів дорівнює `expected.totalZat`, комісія дорівнює `expected.feeZat`; будь-яка розбіжність це `pczt_mismatch` до першого підпису. Підпис за правилом зі скіла (`reference/pczt-and-wasm.md`): кожна Ironwood-action, `WrongSpendAuthorizingKey` пропускається, інші помилки фатальні, мінімум один підпис, інакше `sign_failed`. `rngSeed` використовується для `StdRng::from_seed`, без `getrandom`.

Усі ключові типи обгортаються в `zeroize`, де крейти це підтримують; вхідні буфери `spendSeed` і `orchardSk` копіюються і обнуляються після використання.

## 4. Інтерфейс TypeScript (`@ztab/crypto`)

- `createMaster(): Uint8Array` з `crypto.getRandomValues`, 32 байти.
- `deriveTabKeys(master, tabId, mode, participantsCount)`: HKDF-SHA256 через `crypto.subtle.deriveBits`, `salt` = UTF-8 рядок UUID `tabId`, `info` за watcher-spec §4 (`ztab/v1/spend`, `ztab/v1/admin`, `ztab/v1/group`, `ztab/v1/participant/<i>`), усі по 32 байти. Повертає `{ spendSeed: Uint8Array, adminKey: CryptoKey, groupKey?: CryptoKey, participantKeys?: CryptoKey[] }`. AES-ключі імпортуються як non-extractable `CryptoKey` для `AES-GCM`; `groupKey` лише в режимі `group`, `participantKeys` лише в `individual`.
- `deriveSingleKey(master, tabId, info)`: той самий HKDF для одного ключа; потрібен, щоб із `#g=` або `#p=` відновити лише один `CryptoKey`.
- `sealBlob(key, object): Uint8Array` і `openBlob(key, bytes): object`: AES-256-GCM, формат `version(1 байт, 0x01) || nonce(12) || ciphertext || tag(16)`, nonce випадковий на кожен виклик, JSON усередині. Невідома версія, зміна будь-якого байта або чужий ключ дають `decrypt_failed` без деталей.
- `encodeFragment` і `parseFragment`: `#a=<b64url(master)>`, `#g=<b64url(groupKey)>`, `#p=<i>.<b64url(participantKey[i])>`, base64url без padding; невалідний фрагмент це `invalid_fragment`. Для `#g=` і `#p=` у фрагменті лежить уже виведений ключ, тому `parseFragment` для них повертає сирі 32 байти, які імпортуються як `CryptoKey`.
- `loadWasm()`: ледаче `init` модуля з `pkg/`; обгортки над п'ятьма функціями §3 з TS-типами і перетворенням `Err(String)` у клас `CryptoError { code, message }`.

Коди помилок, які PWA має розрізняти: `invalid_fragment`, `decrypt_failed`, `invalid_recipient`, `invalid_pczt`, `pczt_mismatch`, `sign_failed`, `wasm_unavailable`. Усе інше вважається багом.

## 5. Потоки використання

**Створення табу (Аліса).**
1. `createMaster()`, `tabId = crypto.randomUUID()`, `validateRecipient(network, адреса Аліси)`; відмова не пускає форму далі.
2. `deriveTabKeys` → `deriveTabAccount(spendSeed)` → `ufvk`.
3. Для кожного `i < participantsCount`: `deriveAddress(ufvk, i)`, локальний список.
4. `sealBlob` для admin-блоба і group-блоба або participant-блобів. У блоби додаються адреси учасників, щоб учасник за `#p=` бачив свою адресу з блоба, а не лише від сервера.
5. `PUT /tabs` з `ufvk`, `birthday`, блобами. Відповідь містить `addresses` від watcher: PWA порівнює з локальними за індексом; будь-яка розбіжність означає, що таб не створено, користувач бачить «сервер повернув чужі адреси». Це захист від скомпрометованого API або watcher, який у threat model концепт-документа вважається «чесним, але цікавим»; захист коштує одну функцію, тому входить у MVP і описується в README.
6. `orchardSk` і `spendSeed` після кроків 2 і 5 обнуляються і ніде не зберігаються; живе лише `master` у фрагменті адмін-посилання.

**Відкриття посилання (будь-хто).** `parseFragment` → ключ (`#a=` повторює `deriveTabKeys` і відкриває будь-який блоб) → `openBlob` відповідного блоба. `decrypt_failed` показується як «посилання пошкоджене».

**Закриття (Аліса).**
1. `POST /sweep` → `pczt_b64`, `summary`.
2. `inspectPczt`: екран підтвердження будується з даних PCZT, `summary` показується поруч як «що каже сервер»; розбіжність між ними блокує кнопку.
3. Підтвердження → `deriveTabAccount(spendSeed)` → `signPczt(network, pczt, orchardSk, rngSeed, { recipient: адреса з admin-блоба, totalZat, feeZat з inspect })` → `POST /broadcast`.
4. `rngSeed` новий з `crypto.getRandomValues` на кожен виклик.

## 6. Інваріанти приватності

- Модуль не логує нічого і не має доступу до мережі.
- `master` не покидає TS-шару; Rust отримує лише `spendSeed`.
- Жоден ключ не пишеться в localStorage, IndexedDB чи cookies; усе живе в пам'яті вкладки.
- Фрагмент URL ніколи не потрапляє в запити, що вже гарантує браузер, а PWA додатково не копіює його в історію або аналітику.
- Відмова в `signPczt` відбувається до створення першого підпису.

## 7. Тестування

**Rust, нативно (`cargo test`, без WASM):**
- Фікстура `spend_seed` (hex) → очікувані UFVK і адреси для індексів 0, 1, 7 на тестнеті, згенеровані нативно один раз і закомічені в `crypto/rust/tests/fixtures/`. Той самий seed у тесті `watcher/` дає ті самі адреси: це крос-перевірка між підпроєктами.
- `validateRecipient`: UA з Orchard, UA лише з transparent receiver, t-адреса, TEX, mainnet-UA на testnet, сміття.
- `inspectPczt` і `signPczt` на збережених PCZT: `watcher/tests/fixtures/sweep.proved.pczt` з фікстурного табу (очікуваний результат узгоджується з `sweep.signed.pczt`), PCZT з підміненим одержувачем, PCZT з іншою сумою, PCZT без наших витрат. Підписана PCZT проганяється через `tx-extractor` (dev-dependency) для доказу валідності без мережі.
- HKDF-фікстури з §7 TS перевіряються через `hkdf`-крейт у dev-dependencies, щоб порт `ztab/v1/*` був зафіксований з обох боків.

**TypeScript (Vitest, Node 24, вбудований WebCrypto):**
- HKDF-фікстури: `master`, `tabId` → `spendSeed`, `adminKey`, `groupKey`, `participantKey[0]` у hex.
- `sealBlob`/`openBlob`: roundtrip, зміна байта, чужий ключ, невідома версія.
- Фрагменти: три форми туди-назад, відмова на невалідних.
- Завантаження WASM із `pkg/` і виклик кожної функції на фікстурах із Rust-тестів: ті самі очікувані значення.

**Live на тестнеті (`--ignored`, вручну, ~5 хв):** повтор `full_tab_lifecycle_on_testnet` з watcher, де підпис робить Node через `@ztab/crypto`. Потребує `ZTAB_TEST_SEED_HEX` з `~/.config/ztab/testnet-payer-seed.hex`. Це і є критерій успіху з §1.

**CI:** один job із Docker перевіряє, що `pkg/` збігається зі свіжою збіркою; решта тестів без Docker.

## 8. Відкриті питання і ризики

- **`zcash_keys` з `orchard` під wasm32.** Spike збирав лише `pczt` + `orchard`. Перевіряється першим завданням плану; якщо `zcash_keys` тягне щось несумісне, запасний шлях це виведення через `orchard::keys::SpendingKey::from_zip32_seed` і ручне кодування UA через `zcash_address`.
- **wasm-bindgen і `getrandom`.** У spike bindgen не було, і модуль мав нуль імпортів. Якщо транзитивні залежності через bindgen вимагають `getrandom` з `wasm_js`, це приймається, але модуль усе одно отримує `rngSeed` ззовні. Запасний шлях: сирі експорти, як у spike.
- **Порівняння адрес.** `deriveAddress` і watcher мають використовувати однаковий спосіб (один Orchard-receiver, той самий diversifier index). Крос-тест із §7 ловить розбіжність до того, як її побачить користувач.
- **Розмір `pkg/` у git.** Близько 1–1.5 МБ бінарника на кожну перезбірку; прийнятно для хакатону, після нього переноситься в артефакти CI.
