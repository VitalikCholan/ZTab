# ZTab: інфра — testnet-демо на одному VPS (`deploy/`, GitHub Actions)

Дата: 2026-10-21. Статус: чернетка на рев'ю.
Контекст: концепт-документ у корені; специфікації watcher (`2026-10-15-…`), crypto (`2026-10-16-…`), API (`2026-10-17-…`), PWA (`2026-10-18-…`, §9 приватність, README `pwa/README.md` з очікуваними заголовками проксі); скіл `.claude/skills/ztab-zcash-stack` (мережа, lightwalletd, таймінги). Дедлайн ZECATHON 2026-10-28 23:59 UTC; репо публічне при подачі; витік приватності = дискваліфікація.

## 1. Мета і межі

Підпроєкт 5: живе testnet-демо, яке суддя відкриває за `https://<домен>` і проходить create → pay → withdraw без інструкцій поза застосунком, плюс відтворюваний деплой і CI в публічному репо. Критерій успіху: (1) демо живе з моменту подачі до кінця суддівства без ручного втручання, а суддя платить зі **свого** testnet-гаманця (Vizor Testnet + faucet fauzec.com за інструкцією в README; серверного платника на VPS немає); (2) сторонній інженер піднімає свою копію за `deploy/README.md` за ~30 хвилин; (3) на `main` зелений CI з повними тестами всіх чотирьох пакетів.

**Не входить:** власний Zcash-вузол (Zebra/lightwalletd) — watcher ходить на публічний `https://testnet.zec.rocks:443`; mainnet; масштабування понад один хост; бекапи Postgres (дані табів — зашифровані блоби й хеші; втрата = незручність, не втрата коштів); демо-оплата з серверного гаманця і **вбудований testnet-faucet у застосунку (беклог, рішення Віталія 2026-10-21: «треба організувати фаусет для тестнету у апці» — окремий підпроєкт після інфри)**; кореневий README, інструкції суддям, відео (окремий етап подачі).

**Антицілі:** секрети або адреси в репо, в логах CI чи в образах; PWA без CSP/HSTS; `/t/<id>` без SPA-fallback (404 на посилання учасника); API доступний напряму повз проксі; демо, що падає при перезавантаженні VPS.

## 2. Рішення, ухвалені з Віталієм

1. Хостинг: **Hetzner Cloud CX23** (2 vCPU, 4 ГБ, 40 ГБ), Ubuntu 24.04, один сервер.
2. **Власний домен** купується (Porkbun або Cloudflare Registrar; ім'я обирається при купівлі); у конфігах — змінна `DOMAIN`.
3. Без власного Zcash-вузла: публічний lightwalletd `testnet.zec.rocks`.
4. CI в GitHub Actions **з повними тестами** (crypto, api з Postgres, pwa unit + Playwright, watcher cargo), не лише збірка образів.

5. **Доступу до сервера в агента немає** (варіант Б): усе в `deploy/` перевіряється локальною репетицією (Compose + Caddy з внутрішнім CA + Playwright-smoke), на VPS запускає Віталій за README.

Решта рішень мої й позначені як такі.

## 3. Архітектура (моє рішення)

Один `docker-compose.yml` у `deploy/` з п'ятьма сервісами в приватній мережі; назовні відкриті лише 80/443 (Caddy) і 22 (SSH):

| Сервіс | Образ | Порти | Стан |
|---|---|---|---|
| `caddy` | `caddy:2` | 80, 443 назовні | volume `caddy_data` (сертифікати Let's Encrypt) |
| `pwa` | `ghcr.io/vitalikcholan/ztab-pwa:<tag>` — one-shot контейнер (`FROM scratch`/alpine з `dist/`), який копіює `dist/` у volume `pwa_dist` і завершується; Caddy роздає статику сам | — | volume `pwa_dist` |
| `api` | `ghcr.io/vitalikcholan/ztab-api:<tag>` (існуючий `api/Dockerfile`) | 3000 внутрішньо | — |
| `watcher` | `ghcr.io/vitalikcholan/ztab-watcher:<tag>` (новий `watcher/Dockerfile`, multi-stage `rust:1.98-bookworm` → `debian:bookworm-slim`) | 8787 внутрішньо | volume `watcher_data` (`ZTAB_DATA_DIR`) |
| `postgres` | `postgres:16-alpine` | 5432 внутрішньо | volume `pg_data` |

Маршрутизація Caddy (`deploy/Caddyfile`): `https://{$DOMAIN}` → `file_server` з `pwa_dist`, `try_files {path} /index.html` для SPA (`/t/*`, `/new`, `/new/links`), `Cache-Control: public, max-age=31536000, immutable` для `/assets/*` і `no-cache` для `index.html`/`sw.js`; `https://{$DOMAIN}/api/*` → `api:3000` зі зрізанням префіксу `/api` (`handle_path`). Один origin для PWA й API, тож CORS тривіальний (`CORS_ORIGIN=https://<домен>`), а `connect-src 'self'` у CSP достатній. Заголовки — авторитетне джерело `pwa/README.md`, плюс мої доповнення: `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, `Strict-Transport-Security: max-age=31536000` (**без** `includeSubDomains` — куплений домен може мати інші піддомени; README виправляється), `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`, `X-Content-Type-Options: nosniff`. HSTS вмикається лише коли `DOMAIN` не закінчується на `sslip.io` (репетиційні хости). Для `/api/*` — лише HSTS і `nosniff`. Caddy передає `X-Forwarded-For` (API очікує рівно один проксі — виконано).

PWA збирається **в CI, домен-незалежно**: `VITE_API_URL=/api` (відносний шлях; `ApiClient` конкатенує рядки, тож `fetch('/api/…')` резолвиться відносно origin — перевірити одним unit-тестом, інакше мінімальний фікс у `config.ts`/`client.ts`), `VITE_NETWORK=test`, `VITE_EXPLORER_TX_URL` не задано (`testnet.zcashexplorer.app` застряг до NU7; посилання на експлорер вимкнене, поки не з'явиться робочий testnet-експлорер — перевірити перед подачею). Образ `ztab-pwa` (`pwa/Dockerfile`: стадія `node:24-alpine` + `pnpm build`, фінальна стадія лише з `dist/` і `cp -r` у volume при старті) збирається в CI разом з API і watcher; VPS нічого не збирає — лише `docker compose pull && up`. Усі три пакети GHCR публічні (разовий ручний крок у §5). Ім'я образів: `ghcr.io/vitalikcholan/ztab-{api,watcher,pwa}` (owner у нижньому регістрі).

Змінні (`deploy/.env`, з `deploy/.env.example`): `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `WATCHER_TOKEN` (= `ZTAB_API_TOKEN` watcher'а; один секрет, два імені), `IMAGE_TAG` — `update.sh` записує `sha-<короткий SHA>` щойно підтягнутого `main`, тож compose завжди пінить конкретну збірку; відкат = `IMAGE_TAG=sha-<старий> docker compose up -d`. Похідні задаються в compose: `DATABASE_URL=postgresql://ztab:${POSTGRES_PASSWORD}@postgres:5432/ztab`, `WATCHER_URL=http://watcher:8787`, `ZTAB_LISTEN=0.0.0.0:8787`, `ZTAB_DATA_DIR=/data`, `ZTAB_NETWORK=test`, `ZTAB_CONNECTION=direct`, `ZTAB_LIGHTWALLETD_URL=https://testnet.zec.rocks:443`, `RATE_LIMIT_CREATE_PER_HOUR=60`, `RATE_LIMIT_DEFAULT_PER_MINUTE=600` (судді за одним NAT). Секрети генеруються скриптом `deploy/init-env.sh` (`openssl rand -hex 32`), ніколи не друкуються.

Надійність: `restart: unless-stopped` у всіх; `healthcheck` на `api` (`/healthz`), `watcher` (`/v1/health`), `postgres` (`pg_isready`); `depends_on` з `condition: service_healthy`; `logging: json-file, max-size 10m, max-file 3`. Watcher-логи не містять адрес/сум (інваріант вже в коді). Зовнішній uptime-пінг раз на хвилину (UptimeRobot безкоштовно) на **два** URL: `https://<домен>/api/healthz` і `https://<домен>/api/status` з keyword-перевіркою, що watcher синхронізований (живий ≠ синхронізований) — алерт на email Віталія; налаштовується вручну, документується.

Сервер: `deploy/server-setup.sh` (запускається один раз по SSH): `ufw` (22, 80, 443), `fail2ban`, unattended-upgrades, Docker Engine + compose plugin, користувач `ztab` у групі docker, клон репо в `/opt/ztab`, `deploy/.env` з `init-env.sh`. Оновлення: `deploy/update.sh` = `git pull && IMAGE_TAG=sha-$(git rev-parse --short HEAD) docker compose pull && docker compose up -d` (усе з GHCR). Watcher-wallet (`watcher_data`) переживає оновлення; `docker compose down -v` ніколи не в скриптах.

## 4. CI (`.github/workflows/`, моє рішення)

- `ci.yml` на `push` до `main` і на `pull_request`: чотири паралельні джоби — `crypto` (Vitest, без перезбірки wasm: `crypto/pkg` закомічений; плюс `cargo test` у `crypto/rust`), `watcher` (`cargo test` офлайн-набір, `cargo fmt --check` і `clippy` як окрема нефатальна джоба), `api` (service-контейнер `postgres:16`, `pnpm --filter @ztab/api test && test:e2e`), `pwa` (`typecheck`, `test`, `build`, Playwright e2e — харнес сам піднімає Postgres через `pnpm --filter @ztab/api db:up` (Docker є на `ubuntu-latest`), тож service-контейнера для цієї джоби немає; `playwright install --with-deps chromium`). `crypto/pkg` закомічений і в CI не перезбирається — дрейф відносно `crypto/rust` не перевіряється (свідомий ризик: перезбірка wasm у Docker повільна). Кеш: `pnpm/action-setup` + `actions/cache` для Cargo registry/target. Бейдж CI у README.
- `images.yml` на `push` до `main` (після зеленого `ci.yml`, `workflow_run`) і на теги `v*`: `docker/build-push-action` для `api/Dockerfile`, `watcher/Dockerfile`, `pwa/Dockerfile` → `ghcr.io/vitalikcholan/ztab-{api,watcher,pwa}:{main,sha-<short>,tag}`; Rust-збірка з кешем `cargo-chef` або `--mount=type=cache`, щоб повторні збірки були хвилини, а не 20.
- Жодних секретів у CI, крім `GITHUB_TOKEN` для GHCR. Live-тести watcher'а (`--ignored`, `ZTAB_TEST_SEED_HEX`) у CI не запускаються.

## 5. Ручні кроки Віталія (покроково в `deploy/README.md`)

0. **Першим кроком** купити домен (Porkbun/Cloudflare Registrar); якщо DNS на Cloudflare — запис **DNS only (grey cloud)**, інакше два проксі ламають rate limit API (він рахує рівно один `X-Forwarded-For`).
1. У DNS — `A`-запис `@` (і `www` → `@`) на IP сервера.
2. Створити сервер Hetzner CX23 (Ubuntu 24.04, Nuremberg/Helsinki), додати SSH-ключ.
3. `ssh root@<ip> 'bash -s' < deploy/server-setup.sh` — скрипт запитає `DOMAIN` і `ACME_EMAIL`, решту згенерує.
4. Дочекатися сертифіката (Caddy сам), відкрити `https://<домен>`, пройти create → pay → withdraw з реального гаманця (Vizor Testnet на десктопі; faucet fauzec.com), зафіксувати результат у `pwa/README.md` «Manual testnet run» і в кореневому README.
5. Додати два uptime-монітори (§3).
6. Разово зробити три GHCR-пакети публічними (GitHub → Packages → Package settings → Change visibility) після першого `images.yml`.

## 6. Приватність і безпека на хості

- API недоступний ззовні (лише через `caddy`); Postgres і watcher — лише в приватній мережі compose.
- `deploy/.env` з правами `600`, у `.gitignore`; `init-env.sh` не виводить значення.
- Логи Caddy: access-лог вимкнений; error-лог через `log` з `format filter`, що видаляє `request>uri`, `request>headers` і `request>remote_ip` (щоб `/t/<id>`, txid і IP не осідали у файлах). Це моє рішення: tab id у шляху не секрет, але зайва телеметрія не потрібна.
- Образи без `latest`-дрейфу: compose пінить `IMAGE_TAG` на SHA або `main`; у README — як відкотитись.
- Нічого з `~/.config/ztab` (payer seed) на сервер не потрапляє.

## 7. Тестування

- CI описане в §4 — обов'язкове зелене на `main` перед деплоєм.
- Локальна репетиція (єдина перевірка, бо доступу до VPS немає): `deploy/docker-compose.rehearsal.yml` (override: `DOMAIN=localhost`, Caddy з внутрішнім CA, образи зібрані локально) + `deploy/rehearsal.sh`, який піднімає стек і ганяє Playwright-smoke проти `https://localhost`: `data-wasm=ready` під реальним CSP (wasm compile, service worker), `/t/anything` → 200 з усіма заголовками, `/api/healthz` 200, `/api/status` зі `watcher`; smoke виконується і в CI (`deploy` джоба). Це закриває ризик «CSP ламає wasm/SW у проді».
- `deploy/`: `docker compose config` у CI (валідність), smoke на VPS `deploy/smoke.sh` (на VPS після `up`: `curl -fsS https://$DOMAIN/api/healthz`, `GET /api/status` → `watcher` healthy, `curl -I https://$DOMAIN/t/anything` → 200 з CSP/HSTS заголовками, `curl -I http://$DOMAIN` → 308 на https).
- Повний ручний прогін на testnet (§5.4) — єдина перевірка реального підпису в проді; результат записується.

## 8. Що лишається будівельнику

Точна структура `watcher/Dockerfile` (cargo-chef чи mount-cache), як саме one-shot `pwa` заповнює volume (entrypoint з `cp`), налаштування fail2ban, спосіб ротації `IMAGE_TAG`, формат бейджів.

## 9. Ризики

- Публічний `testnet.zec.rocks` падає під час суддівства — немає запасного (власний вузол поза межами). Пом'якшення: `ZTAB_LIGHTWALLETD_URL` у `.env`, README називає альтернативні публічні testnet-lightwalletd, якщо є.
- Let's Encrypt rate limit при повторних пересозданнях сервера — `caddy_data` volume зберігати; у крайньому разі staging CA.
- Rust-образ у GitHub Actions без кешу — 15–25 хв; кеш обов'язковий.
- Судді на одному NAT упираються в rate limit — підняті ліміти в §3.
- `testnet.zcashexplorer.app` застарілий — посилання на експлорер вимкнене, це нормально для демо.

## 10. Зміни після реалізації

Що будівельник зробив інакше, ніж у специфікації, і чому.

- **HSTS.** Правило з §3 реалізоване CEL-матчером Caddy: `"{$DOMAIN}" != "localhost" && !"{$DOMAIN}".endsWith("sslip.io")`; `{$DOMAIN}` підставляється при розборі Caddyfile, тож правило фіксоване на деплой. Матчер `host *.sslip.io` не годиться: він пропускає багаторівневі хости на кшталт `1.2.3.4.sslip.io`. Тест: smoke піднімає одноразові контейнери `caddy:2.11` з `DOMAIN=ztab.example` (HSTS є) та `203-0-113-7.sslip.io` / `203.0.113.7.sslip.io` (HSTS немає).
- **HSTS від API.** helmet в API шле власний `Strict-Transport-Security` з `includeSubDomains`; Caddy прибирає його (`header_down -Strict-Transport-Security`) і ставить єдиний HSTS за правилом вище. `nosniff` на `/api/*` замінюється, а не дублюється.
- **CSP без `'unsafe-eval'`.** Zod v4 пробує JIT через `Function("")`, що дає порушення CSP. Додано `pwa/src/zod-config.ts` (`z.config({ jitless: true })`), імпортований першим у `main.tsx`; CSP з §3 лишається без змін.
- **CA репетиції.** Caddy у репетиції працює з `local_certs` (токен `{$CADDY_LOCAL_CERTS}` у глобальному блоці Caddyfile, у проді порожній, тож тестується той самий файл). Кореневий та проміжний сертифікати експортуються в `deploy/smoke/.ca.crt`: Node довіряє їм через `NODE_EXTRA_CA_CERTS`, Chromium лише публічним ключам цього ланцюга через `--ignore-certificate-errors-spki-list`; `ignoreHTTPSErrors` не використовується, service worker реєструється під справжнім TLS.
- **Порти.** Публікуються `80`, `443` і `443/udp` (HTTP/3); у репетиції лише `127.0.0.1` 80/443 через `ports: !override` (Compose ≥ 2.24).
- **Сервіс `pwa`** має `restart: "no"` (one-shot; з `unless-stopped` він би крутився в циклі), попри «усі сервіси `unless-stopped`».
- **Статичні файли.** `/assets/*` без SPA-fallback: відсутній ассет дає 404 без `immutable`, а не закешований `index.html`. `no-cache` діє на все поза `/assets/*` (надмножина чотирьох файлів зі спеки), щоб deep link `/t/<id>` не кешувався евристично.
- **Error-лог.** Додатково видаляється `request>client_ip` (Caddy 2.11 логує і його). Тест зупиняє API, щоб отримати 502 (4xx логується на DEBUG і не дає покриття), тому цей smoke **ніколи не запускати проти продакшну**.
- **`server-setup.sh`** запускається як `ssh root@<ip> "DOMAIN=… ACME_EMAIL=… bash -s" < deploy/server-setup.sh`: stdin зайнятий скриптом, тож інтерактивний `read` неможливий, значення передаються через змінні середовища. Тіло загорнуте в `main()`, щоб файл розібрався повністю до виконання.
- **`update.sh`**: `git fetch` → `docker compose pull` для `sha-<7>` (`--short=7`, збігається з тегом `images.yml`) → лише після успіху `git merge --ff-only` і запис `IMAGE_TAG`. Якщо образів ще нема: `images for sha-<x> not published yet`, нічого не змінено.
- **Приватний репозиторій.** Поки репозиторій приватний, `git clone` на VPS і pull з GHCR не працюють; у README крок «репо та пакети публічні» поставлений перед `server-setup.sh` (нумерація 0–6 лишилась зі спеки).
- **CI** (`ci.yml`): джоби crypto, watcher, watcher-lint (fmt + clippy, advisory), api, pwa, deploy; runner `ubuntu-24.04`. Типові часи: crypto 1–2 хв, watcher ~3,3 хв, watcher-lint ~3,4 хв, api ~1,3 хв, pwa ~2,5 хв, deploy 15–17 хв (збірка образів ≈14 хв, smoke ≈7 с). Docker layer cache не додавали (поріг 25 хв не перевищено; для `type=gha` довелося б переписати збірку на `build-push-action`). Мажори actions піднято до Node 24 (`checkout@v7`, `setup-node@v7`, `pnpm/action-setup@v6`); у watcher виконано `cargo fmt`, щоб lint був зелений.
- **`images.yml`**: контекст збірки watcher це `watcher` (його Dockerfile і `.dockerignore` написані під нього), api і pwa збираються з `.`. Тригер `workflow_run` після CI на `main` збирає саме `head_sha`, який тестував CI; тег `main` рухається лише якщо цей SHA є верхівкою гілки. Job виконується лише для `push` з того ж репозиторію й гілки `main` (захист від fork-PR). Тимчасовий `push` на `infra` був потрібен для першого прогону, бо `workflow_dispatch` недоступний, поки workflow не на `main`; потім видалений.
- **`rehearsal.sh --from-ghcr <tag>`** тягне опубліковані образи й перетегує їх у `ztab-*:rehearsal`, пропускаючи збірку.

### Відкрито для власника

- Зробити репозиторій і три GHCR-пакети (`ztab-api`, `ztab-watcher`, `ztab-pwa`) публічними.
- Після цього один раз виконати `bash deploy/rehearsal.sh --from-ghcr <sha>`: токен агента не мав `read:packages`, тож публіковані образи ще не перевірені.
- Перший справжній прогін `images.yml` (через `workflow_run`) станеться після мержу в `main`.
- Перший реальний запуск `server-setup.sh` на VPS і ручний прогін на testnet (запис у `pwa/README.md`).
