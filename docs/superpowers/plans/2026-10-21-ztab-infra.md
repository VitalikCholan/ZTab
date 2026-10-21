# ZTab Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible one-VPS testnet deployment of ZTab (`deploy/` with Docker Compose + Caddy), container images for all three services built by GitHub Actions, CI with the full test suites, and a local rehearsal that proves the stack (TLS, CSP, SPA fallback, wasm) before anyone touches a server.

**Architecture:** Five Compose services on a private network — `caddy` (TLS, static `dist/` from a volume, `/api/*` proxy, security headers), `pwa` (one-shot image that copies `dist/` into the volume), `api`, `watcher` (sqlite on a volume), `postgres`. Images come from GHCR, pinned by `sha-<short>`; the VPS only pulls. The same Compose + Caddyfile run locally with Caddy's internal CA so a Playwright smoke can assert the production headers and wasm boot; CI runs that rehearsal plus every package's tests.

**Tech Stack:** Docker Compose v2, Caddy 2 (`caddy:2-alpine`), `postgres:16-alpine`, multi-stage Dockerfiles (`rust:1.98-bookworm` → `debian:bookworm-slim`; `node:24-alpine`), GitHub Actions (`docker/build-push-action`, `pnpm/action-setup`, `Swatinem/rust-cache`), Playwright 1.64 (reuse `@ztab/pwa` devDependencies), bash + shellcheck.

**Spec:** `docs/superpowers/specs/2026-10-21-ztab-infra-design.md`

## Global Constraints

- Hosting target: Hetzner CX23, Ubuntu 24.04, Docker Engine + compose plugin; only 22/80/443 open. The agent has no server access: everything is verified by the local rehearsal and CI.
- Images: `ghcr.io/vitalikcholan/ztab-{api,watcher,pwa}` tagged `main`, `sha-<short 7>`, and `v*`; Compose pins `IMAGE_TAG` (default `main`); `update.sh` writes `sha-$(git rev-parse --short HEAD)`.
- Compose env (`deploy/.env` from `deploy/.env.example`): `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `WATCHER_TOKEN`, `IMAGE_TAG`. Derived in compose: `DATABASE_URL=postgresql://ztab:${POSTGRES_PASSWORD}@postgres:5432/ztab`, `WATCHER_URL=http://watcher:8787`, `ZTAB_API_TOKEN=${WATCHER_TOKEN}`, `ZTAB_LISTEN=0.0.0.0:8787`, `ZTAB_DATA_DIR=/data`, `ZTAB_NETWORK=test`, `ZTAB_CONNECTION=direct`, `ZTAB_LIGHTWALLETD_URL=https://testnet.zec.rocks:443`, `CORS_ORIGIN=https://${DOMAIN}`, `RATE_LIMIT_CREATE_PER_HOUR=60`, `RATE_LIMIT_DEFAULT_PER_MINUTE=600`, `PORT=3000`.
- Caddy headers (verbatim): `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`; `Strict-Transport-Security: max-age=31536000` only when `DOMAIN` does not end in `sslip.io` and is not `localhost`; `Referrer-Policy: no-referrer`; `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`; `X-Content-Type-Options: nosniff`. `/api/*` gets only HSTS (same rule) and `nosniff`. `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`; `no-cache` for `/index.html`, `/sw.js`, `/manifest.webmanifest`, `/registerSW.js`.
- Caddy logging: no access log; error log with `format filter` deleting `request>uri`, `request>headers`, `request>remote_ip`.
- PWA build args: `VITE_API_URL=/api`, `VITE_NETWORK=test`, `VITE_EXPLORER_TX_URL` unset.
- Privacy: `deploy/.env` mode 600 and git-ignored (`*.env`/`.env.*` already in `.gitignore`); scripts never echo secret values; nothing from `~/.config/ztab` is referenced; API/Postgres/watcher ports are `expose`d, never `ports:`-published.
- Reliability: every service `restart: unless-stopped`; healthchecks on `api` (`/healthz`), `watcher` (`/v1/health`), `postgres` (`pg_isready -U ztab -d ztab`); `depends_on` with `condition: service_healthy`; `logging: {driver: json-file, options: {max-size: 10m, max-file: "3"}}`.
- Shell for local work: prepend `$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/pnpm` to `PATH`; Docker Desktop running. Commits `infra: …`, `ci: …`, `pwa: …`, `watcher: …`.
- Out of scope: own Zcash node, mainnet, Postgres backups, demo payment / in-app faucet (backlog), root submission README (only a minimal root README with badges and links is created here), judge instructions, video.

## Review Focus

1. A judge opens a participant link cold (`https://<domain>/t/<id>#p=…`): Caddy must answer `200` with `index.html` and the full header set, never `404` (Task 3 smoke `deep link to /t/<id> serves index.html with headers`).
2. The wasm module must compile under the production CSP (`'wasm-unsafe-eval'`) and the service worker must register (`worker-src 'self'`) — a wrong CSP silently kills every tab page (Task 3 smoke `wasm boots and service worker registers under CSP`).
3. `http://<domain>` must redirect to HTTPS, and a rehearsal host (`localhost`, `*.sslip.io`) must not receive HSTS, or a throwaway domain gets pinned for a year (Task 3 smoke `http redirects; HSTS only on real domains`).
4. The API must be unreachable except through Caddy: a published `3000`/`8787`/`5432` would expose the bearer-protected watcher and the DB (Task 3 smoke `only 80 and 443 are published`).
5. `init-env.sh`/`server-setup.sh` must never print secrets, and a second run must not regenerate `.env` (a regenerated `WATCHER_TOKEN` would strand the running watcher) (Task 4 test `init-env is idempotent and silent`).

## File structure

```
watcher/Dockerfile                          multi-stage Rust image (Task 1)
pwa/Dockerfile, pwa/docker-entrypoint.sh    build dist, one-shot copy into volume (Task 2)
pwa/test/config.test.ts, pwa/test/api/client.test.ts   relative VITE_API_URL (Task 2)
deploy/docker-compose.yml                   production stack (Task 3)
deploy/docker-compose.rehearsal.yml         override: localhost, tls internal, local images (Task 3)
deploy/Caddyfile                            routes, headers, log filter (Task 3)
deploy/.env.example                         documented variables (Task 3)
deploy/rehearsal.sh, deploy/smoke/          bring up locally + Playwright smoke (Task 3)
deploy/init-env.sh, server-setup.sh, update.sh, smoke.sh   server scripts (Task 4)
deploy/test/*.bats or deploy/test/*.sh     script tests (Task 4)
deploy/README.md                            runbook for Vitalii and for third parties (Task 4)
.github/workflows/ci.yml                    tests + rehearsal (Task 5)
.github/workflows/images.yml                GHCR images (Task 6)
README.md (root, minimal), pwa/README.md (HSTS fix), spec "Зміни після реалізації" (Task 7)
```

---

### Task 1: Watcher container image

**Files:**
- Create: `watcher/Dockerfile`, `watcher/.dockerignore`
- Modify: `watcher/README.md` (a "Container" section)
- Test: build + run smoke in the task steps (no unit test; the image is the artifact)

**Interfaces:**
- Produces: image `ztab-watcher` whose entrypoint is `/usr/local/bin/ztab-watcher`, listens on `ZTAB_LISTEN` (default must be overridden to `0.0.0.0:8787` by Compose), stores data in `ZTAB_DATA_DIR=/data` (declared `VOLUME /data`), runs as non-root user `watcher` (uid 10001), `EXPOSE 8787`, `HEALTHCHECK` = `curl -fsS -H "Authorization: Bearer $ZTAB_API_TOKEN" http://127.0.0.1:8787/v1/health` (check in `watcher/src/http` whether `/v1/health` needs the bearer; if it is public, drop the header).

- [ ] **Step 1:** Write `watcher/Dockerfile`: stage `chef` (`rust:1.98-bookworm`, `cargo install cargo-chef`), `planner` (`cargo chef prepare`), `builder` (`cargo chef cook --release` then `cargo build --release --locked`; `apt-get install -y clang lld` if the cohort needs them — the crypto build did), `runtime` (`debian:bookworm-slim` + `ca-certificates curl`, copy the binary, `USER watcher`, `VOLUME /data`, `ENV ZTAB_DATA_DIR=/data ZTAB_LISTEN=0.0.0.0:8787`). `.dockerignore`: `target/`, `data/`, `*.sqlite`.
- [ ] **Step 2:** `docker build -f watcher/Dockerfile -t ztab-watcher:dev watcher` — expected: success; `docker image ls ztab-watcher:dev` shows < 200 MB.
- [ ] **Step 3:** `docker run --rm -d --name w -e ZTAB_API_TOKEN=t -v w_data:/data -p 127.0.0.1:18787:8787 ztab-watcher:dev` then `curl -fsS -H 'Authorization: Bearer t' http://127.0.0.1:18787/v1/health` — expected: JSON with the watcher's health fields (it syncs from `testnet.zec.rocks`); `docker inspect --format '{{.State.Health.Status}}' w` becomes `healthy` within 60 s; `docker rm -f w; docker volume rm w_data`.
- [ ] **Step 4:** README section: build command, env, volume, health.
- [ ] **Step 5: Commit** `watcher: container image (cargo-chef, bookworm-slim, non-root)`.

---

### Task 2: PWA image and relative API URL

**Files:**
- Create: `pwa/Dockerfile`, `pwa/docker-entrypoint.sh`, `pwa/.dockerignore`
- Modify: `pwa/src/config.ts` only if the relative URL is rejected; `pwa/README.md` (Container section + `VITE_API_URL` may be a path)
- Test: `pwa/test/config.test.ts` (`accepts a relative VITE_API_URL`), `pwa/test/api/client.test.ts` (`requests resolve against the page origin when baseUrl is a path`)

**Interfaces:**
- Produces: image `ztab-pwa` built from the repo root (`docker build -f pwa/Dockerfile --build-arg VITE_API_URL=/api --build-arg VITE_NETWORK=test -t ztab-pwa .`), containing `/dist`; entrypoint `docker-entrypoint.sh` copies `/dist/.` into `/srv/pwa` (the mounted volume) with `rm -rf /srv/pwa/*` first, prints `pwa: dist copied (<n> files)`, exits 0. `VITE_API_URL=/api` is a supported value.

- [ ] **Step 1: Failing tests.** `config.test.ts`: `loadConfig({VITE_API_URL: '/api', VITE_NETWORK: 'test'}).apiUrl === '/api'`. `client.test.ts`: `new ApiClient('/api', fetchMock).status()` calls `fetchMock` with first argument `'/api/status'` (string, not a `URL`) — this is what the browser resolves against `location.origin`.
- [ ] **Step 2:** `pnpm --filter @ztab/pwa test` — fail if `loadConfig` validates URLs as absolute (otherwise both pass immediately; then the tests pin the contract and Step 3 is a no-op).
- [ ] **Step 3:** Make them pass with the smallest change in `config.ts`.
- [ ] **Step 4:** `pwa/Dockerfile`: stage `build` (`node:24-alpine`, `pnpm@11.9.0`, copy workspace manifests + `crypto` + `pwa`, `pnpm install --frozen-lockfile --filter @ztab/pwa...`, `ARG VITE_API_URL VITE_NETWORK VITE_EXPLORER_TX_URL`, `pnpm --filter @ztab/pwa build`), stage `runtime` (`alpine:3.20`, `COPY --from=build /repo/pwa/dist /dist`, entrypoint). Build it; `docker run --rm -v p:/srv/pwa ztab-pwa:dev` prints the copied count; `docker run --rm -v p:/srv/pwa alpine ls /srv/pwa` lists `index.html`, `assets/`, `sw.js`, `manifest.webmanifest`; `grep -c '/api' ` on the built JS in the volume ≥ 1 and no `127.0.0.1:3000`.
- [ ] **Step 5:** `pnpm --filter @ztab/pwa typecheck && test && build && e2e` still green (the Playwright harness keeps its absolute `VITE_API_URL`).
- [ ] **Step 6: Commit** `pwa: container image with one-shot dist copy; relative VITE_API_URL`.

---

### Task 3: Compose stack, Caddyfile, local rehearsal with Playwright smoke

**Files:**
- Create: `deploy/docker-compose.yml`, `deploy/docker-compose.rehearsal.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/rehearsal.sh`, `deploy/smoke/playwright.config.ts`, `deploy/smoke/stack.spec.ts` (no new package: the smoke reuses `@ztab/pwa`'s Playwright — `pnpm --filter @ztab/pwa exec playwright test --config ../deploy/smoke/playwright.config.ts`)
- Test: the smoke spec is the test; `deploy/rehearsal.sh` must exit 0 on a clean machine with Docker

**Interfaces:**
- Consumes: Task 1/2 images (`IMAGE_TAG` or local `:dev` tags via the rehearsal override), `api/Dockerfile`.
- Produces: `deploy/rehearsal.sh [--keep]` → builds the three images locally (tags `ztab-{api,watcher,pwa}:rehearsal`), runs `docker compose -f docker-compose.yml -f docker-compose.rehearsal.yml up -d --wait`, runs the smoke against `https://localhost`, tears down unless `--keep`; exit code = smoke result. Rehearsal override: `DOMAIN=localhost`, Caddy `tls internal`, `ports: 127.0.0.1:443:443, 127.0.0.1:80:80`, images `ztab-*:rehearsal`; Caddy's root CA is exported for Playwright via `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt deploy/smoke/.ca.crt` and Playwright uses `ignoreHTTPSErrors: true` only if the CA import is impractical (say which).

- [ ] **Step 1: Write the smoke spec first** (`deploy/smoke/stack.spec.ts`, base URL `https://localhost`): `deep link to /t/<id> serves index.html with headers` — `GET /t/0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70` → 200, body contains `<title>ZTab</title>`, headers equal the Global Constraints set verbatim (CSP, Referrer-Policy, Permissions-Policy, nosniff) and **no** `strict-transport-security` (localhost); `wasm boots and service worker registers under CSP` — open `/`, wait `document.documentElement.dataset.wasm === 'ready'` ≤ 10 s, `navigator.serviceWorker.ready` resolves ≤ 10 s, page console has no `Content Security Policy` errors; `assets are immutable, index is no-cache` — `/assets/<first js from index.html>` has `cache-control: public, max-age=31536000, immutable`, `/index.html` and `/sw.js` have `no-cache`; `api is proxied` — `GET /api/healthz` 200, `GET /api/status` JSON with `network: 'test'` and `watcher` ∈ `{ok, stale, down}`; `http redirects; HSTS only on real domains` — `http://localhost/` → 308/301 to `https://localhost/`; `only 80 and 443 are published` — `docker compose ps --format json` shows no published port other than 80/443 (run from the spec via `child_process`), and `fetch('http://127.0.0.1:3000/healthz')` rejects; `error log has no URIs` — request `GET /api/does-not-exist` and `GET /t/x?secret=1`, then `docker compose logs caddy` contains neither `does-not-exist` nor `secret=1`.
- [ ] **Step 2:** Run the smoke against nothing — expected: all fail (connection refused).
- [ ] **Step 3:** Write `docker-compose.yml` (five services per Global Constraints; `caddy` mounts `pwa_dist:/srv/pwa:ro`, `caddy_data`, `caddy_config`; `pwa` mounts `pwa_dist:/srv/pwa`; `api` `depends_on: {postgres: service_healthy, watcher: service_healthy}`; `caddy` `depends_on: {pwa: service_completed_successfully, api: service_healthy}`), `Caddyfile` (`{$DOMAIN}` site: `encode gzip`, `handle_path /api/*` → `reverse_proxy api:3000`, `handle` → `root * /srv/pwa`, `try_files {path} /index.html`, `file_server`; `header` blocks per Global Constraints; HSTS via a `@hsts` matcher on `{$DOMAIN}` not matching `localhost`/`*.sslip.io` — or an env `HSTS` computed by `rehearsal.sh`/`server-setup.sh`, builder's call; `log { output stderr; format filter { wrap console; fields { request>uri delete; request>headers delete; request>remote_ip delete } } }`), `.env.example` (every variable with a comment), the rehearsal override, `rehearsal.sh`.
- [ ] **Step 4:** `bash deploy/rehearsal.sh` — expected: builds, `up --wait` healthy, smoke 7/7 passed, teardown. Also `docker compose -f deploy/docker-compose.yml config` exits 0 with `.env.example` copied to `.env`.
- [ ] **Step 5: Commit** `infra: compose stack, Caddyfile, local rehearsal with Playwright smoke`.

---

### Task 4: Server scripts and runbook

**Files:**
- Create: `deploy/init-env.sh`, `deploy/server-setup.sh`, `deploy/update.sh`, `deploy/smoke.sh`, `deploy/README.md`, `deploy/test/scripts.test.sh`
- Test: `deploy/test/scripts.test.sh` (bash; run under `bash` with a temp dir; CI runs it + `shellcheck`)

**Interfaces:**
- Produces: `init-env.sh [dir]` — creates `<dir>/.env` from `.env.example` with `POSTGRES_PASSWORD` and `WATCHER_TOKEN` = `openssl rand -hex 32`, asks `DOMAIN` and `ACME_EMAIL` interactively unless given as env, `chmod 600`, prints only `deploy/.env written` ; exits 0 without touching an existing `.env` (prints `deploy/.env exists, keeping it`). `server-setup.sh` (run as root on Ubuntu 24.04): apt `ufw fail2ban unattended-upgrades docker-ce docker-compose-plugin`, `ufw allow 22,80,443/tcp && ufw --force enable`, user `ztab` in `docker`, `git clone https://github.com/VitalikCholan/ZTab /opt/ztab` (or pull), `init-env.sh /opt/ztab/deploy`, `systemd` unit `ztab.service` (`docker compose up -d` on boot, `WorkingDirectory=/opt/ztab/deploy`), first `update.sh`. `update.sh`: `git pull --ff-only`, `IMAGE_TAG=sha-$(git rev-parse --short HEAD)` written into `.env` (replace line), `docker compose pull`, `docker compose up -d --remove-orphans`, `smoke.sh`. `smoke.sh`: `curl -fsS https://$DOMAIN/api/healthz`, `curl -fsS https://$DOMAIN/api/status | grep -q '"network":"test"'`, `curl -sI https://$DOMAIN/t/x | grep -qi 'content-security-policy'`, `curl -sI http://$DOMAIN | grep -q '^location: https'`; prints `smoke OK` or the failing check.

- [ ] **Step 1: Failing tests** in `deploy/test/scripts.test.sh`: `init-env is idempotent and silent` (run twice in a temp dir with `DOMAIN=example.org ACME_EMAIL=a@b.c`; `.env` exists with mode 600, `WATCHER_TOKEN` is 64 hex chars, second run leaves the file byte-identical, combined stdout+stderr contains neither the token nor the password); `update.sh writes the sha tag` (in a temp git repo with a fake `docker` on `PATH` that logs its args: `.env` gets `IMAGE_TAG=sha-<short>`, docker was called with `compose pull` then `compose up -d --remove-orphans`); `shellcheck` passes on all five scripts (`shellcheck -x deploy/*.sh`; install via `brew install shellcheck` locally if missing).
- [ ] **Step 2:** Run — fail (scripts missing).
- [ ] **Step 3:** Implement the scripts; `server-setup.sh` is not unit-tested (needs root Ubuntu) — keep it linear, `set -euo pipefail`, idempotent (`apt-get install -y`, `id ztab || useradd`, `[ -d /opt/ztab ] || git clone`).
- [ ] **Step 4:** Write `deploy/README.md`: What runs where (table from spec §3), Prerequisites, Vitalii's steps 0–6 verbatim from spec §5 (domain first; Cloudflare grey-cloud note; GHCR visibility), Update & rollback (`IMAGE_TAG=sha-<old> docker compose up -d`), Monitoring (two UptimeRobot checks: `/api/healthz`, `/api/status` keyword `"watcher":"ok"`), Logs (`docker compose logs`, what is filtered), Rehearsal (`deploy/rehearsal.sh`), Troubleshooting (Let's Encrypt rate limit → keep `caddy_data`; port 3000 busy locally; watcher `stale`). Every command copy-pasteable.
- [ ] **Step 5:** `bash deploy/test/scripts.test.sh` green; `shellcheck` clean.
- [ ] **Step 6: Commit** `infra: server scripts (init-env, setup, update, smoke) and runbook`.

---

### Task 5: CI workflow with full tests and the rehearsal

**Files:**
- Create: `.github/workflows/ci.yml`
- Test: the workflow run itself on the feature branch (`git push -u origin infra`, `gh run watch`), all jobs green

**Interfaces:**
- Produces: workflow `CI` on `push` (branches `main`, `infra`) and `pull_request`; jobs: `crypto` (`pnpm install --frozen-lockfile`, `pnpm --filter @ztab/crypto test`, `cargo test --manifest-path crypto/rust/Cargo.toml`), `watcher` (`cargo test` in `watcher/`, `cargo fmt --check` + `cargo clippy -- -D warnings` in a separate `continue-on-error: true` job `watcher-lint`), `api` (service `postgres:16` with `ztab/ztab/ztab_test` on `55432:5432`, `pnpm --filter @ztab/api test`, `prisma migrate deploy`-free because `global-setup.ts` does it, `pnpm --filter @ztab/api test:e2e`), `pwa` (`typecheck`, `test`, `build`, `playwright install --with-deps chromium`, `e2e` — the harness runs `db:up` itself, so no service container; jobs run on separate runners, so the `api` job's service on 55432 cannot collide), `deploy` (`shellcheck`, `bash deploy/test/scripts.test.sh`, `bash deploy/rehearsal.sh` — builds images on the runner; cache Docker layers with `docker/build-push-action` `cache-from/to: type=gha` or accept ~15 min; builder's call, document). Caches: `pnpm/action-setup@v4` + `actions/setup-node@v4` with `cache: pnpm`, `Swatinem/rust-cache@v2` for both Cargo projects. Node 24, Rust 1.98 (`dtolnay/rust-toolchain@1.98`). Concurrency group per ref, cancel in progress.

- [ ] **Step 1:** Write the workflow.
- [ ] **Step 2:** `git push -u origin infra` (feature branch; never force) and `gh run watch` — expected: every job green. Fix flakiness by reading the job log (`gh run view --log-failed`), never by retry loops; if the rehearsal exceeds 25 min, add the GHA layer cache.
- [ ] **Step 3: Commit** `ci: full test suites and deploy rehearsal on every push and PR` (plus any follow-up fix commits, each green).

---

### Task 6: Image publishing workflow

**Files:**
- Create: `.github/workflows/images.yml`
- Test: `workflow_dispatch` run on the `infra` branch (`gh workflow run images.yml --ref infra`, `gh run watch`); then `docker pull ghcr.io/vitalikcholan/ztab-watcher:sha-<short>` succeeds after Vitalii flips visibility (or with `gh auth token` login before that)

**Interfaces:**
- Produces: workflow `Images` on `workflow_run` of `CI` (branch `main`, conclusion success), on `push` tags `v*`, and `workflow_dispatch`; matrix `{api: api/Dockerfile, watcher: watcher/Dockerfile, pwa: pwa/Dockerfile}` with context `.`; `docker/metadata-action` tags `main` (default branch), `sha-<short>` (`type=sha,prefix=sha-,format=short`), `v*`; `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN` (`permissions: packages: write`); `build-push-action` with `cache-from/to: type=gha,scope=<image>`; PWA build args `VITE_API_URL=/api VITE_NETWORK=test`; platform `linux/amd64` only.

- [ ] **Step 1:** Write the workflow.
- [ ] **Step 2:** `gh workflow run images.yml --ref infra && gh run watch` — expected: three images pushed; `gh api /user/packages/container/ztab-watcher/versions` lists the `sha-` tag.
- [ ] **Step 3:** `deploy/rehearsal.sh --from-ghcr sha-<short>` (add this flag: skip local builds, use `IMAGE_TAG`) passes against the published images (requires `docker login ghcr.io` locally if still private — document).
- [ ] **Step 4: Commit** `ci: publish api, watcher and pwa images to GHCR`.

---

### Task 7: Docs: root README (minimal), PWA README fix, spec changes note

**Files:**
- Create: `README.md` (root, minimal: one paragraph, CI badge `![CI](https://github.com/VitalikCholan/ZTab/actions/workflows/ci.yml/badge.svg)`, package table linking `watcher/README.md`, `crypto/README.md`, `api/README.md`, `pwa/README.md`, `deploy/README.md`, and the specs folder; a "Status" line naming the submission README as upcoming)
- Modify: `pwa/README.md` (HSTS → `max-age=31536000` without `includeSubDomains`; CSP block = Global Constraints set; note that Caddy in `deploy/` sets them), `docs/superpowers/specs/2026-10-21-ztab-infra-design.md` (append "Зміни після реалізації": anything the builder decided differently, HSTS matcher mechanism, rehearsal CA handling, CI timings)
- Test: fact-check pass — every command in the three READMEs exists in the repo as written (`grep` each script/flag); CI badge URL resolves after Task 5 merged… (on the branch it shows "no status" — acceptable)

- [ ] **Step 1:** Write/modify the files.
- [ ] **Step 2:** Final check from the root: `pnpm -r typecheck && pnpm -r test && bash deploy/test/scripts.test.sh && docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config >/dev/null` and the CI run on the branch green.
- [ ] **Step 3: Commit** `docs: root README with badges, PWA headers aligned with Caddy, infra spec changes note`.
