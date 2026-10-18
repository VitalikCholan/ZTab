# @ztab/api

NestJS 12 (native ESM) REST API between the ZTab PWA and the Rust watcher. It stores opaque encrypted blobs, hashed bearer tokens and tab lifecycle state in PostgreSQL, and proxies the watcher. It never sees spend keys, tokens in clear, or blob contents.

Design: [`docs/superpowers/specs/2026-10-17-ztab-api-design.md`](../docs/superpowers/specs/2026-10-17-ztab-api-design.md). Request and response bodies are specified in its section 6; this README does not repeat them.

## Run locally

Requires Node 24 and pnpm 11 (see the root `package.json`).

```sh
pnpm install
pnpm --filter @ztab/api db:up          # PostgreSQL on localhost:55432
cp api/.env.example api/.env           # edit WATCHER_TOKEN; the app does not read .env itself
set -a; . api/.env; set +a
cd api && npx prisma migrate deploy
pnpm --filter @ztab/api build && pnpm --filter @ztab/api start
```

The watcher must be reachable at `WATCHER_URL` for tab creation, sweep and broadcast. Reads degrade to `stale: true` when it is not.

Docker (build context is the repo root):

```sh
docker build -f api/Dockerfile -t ztab-api .
docker run --rm -e DATABASE_URL=... -e WATCHER_TOKEN=... -e WATCHER_URL=... -p 3000:3000 ztab-api
```

The entrypoint runs `prisma migrate deploy`, then `node dist/src/main.js` as the unprivileged `node` user. It exits non-zero naming `DATABASE_URL` or `WATCHER_TOKEN` when one is missing. SIGTERM closes HTTP and Prisma.

## Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | PostgreSQL connection string |
| `WATCHER_TOKEN` | yes | | Bearer token the API presents to the watcher |
| `WATCHER_URL` | no | `http://127.0.0.1:8080` | Watcher base URL |
| `ZTAB_NETWORK` | no | `test` | `test` or `main`; selects the accepted UFVK prefix (`uviewtest` / `uview1`) |
| `CORS_ORIGIN` | no | `http://localhost:5173` | Allowed browser origin |
| `PORT` | no | `3000` | Listen port |
| `RATE_LIMIT_CREATE_PER_HOUR` | no | `10` | `PUT /tabs` budget per client IP per hour (positive integer) |
| `RATE_LIMIT_DEFAULT_PER_MINUTE` | no | `120` | Budget for every other route per client IP per minute (positive integer) |
| `RATE_URL` | no | CoinGecko simple-price URL for ZEC/USD | Upstream for `GET /rate`; must answer `{"zcash":{"usd":<number>}}` |
| `ZTAB_DISABLE_CRON` | no | unset | Tests only: disables the archive and purge cron jobs. Never set it in production |

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `PUT /tabs/:tab_id` | none | Create a tab (201), or retry it (200) |
| `GET /tabs/:tab_id` | any role | Role-scoped tab view with watcher facts; admin and group also get `balance` (`spendable_zat`, `pending_zat`, `swept_zat`, `min_unspent_confirmations`), participants never do |
| `POST /tabs/:tab_id/sweep` | admin | Proxy: build the sweep PCZT |
| `POST /tabs/:tab_id/broadcast` | admin | Proxy: broadcast the signed PCZT |
| `GET /tabs/:tab_id/sweep` | admin | Proxy: sweep status, plus `history` of sweeps (newest first: `txid`, `output_zat`, `fee_zat`, `mined_height`, `confirmations`) |
| `GET /rate` | none | USD per ZEC (`usd_per_zec`, `fetched_at`, `source`), cached 60 s; `503 rate_unavailable` when the upstream fails or takes over 5 s |
| `GET /status` | none | Network and watcher health, nothing about tabs |
| `GET /healthz` | none | Liveness: `200` and the version |

Purge rule: a tab nobody opens for 30 days (`last_access_at`), in any state, is deleted; links stop working and funds that arrive later stay on the tab key. `closed_at` is informational only.

Auth is `Authorization: Bearer <base64url(token)>`. Missing token is 401; an unknown tab and a token that is not that tab's both give an identical 404; the right tab with the wrong role is 403. Errors are `{"error":{"code","message"}}`.

## Tests

```sh
pnpm --filter @ztab/api db:up          # PostgreSQL for e2e (Docker)
pnpm --filter @ztab/api test           # unit
pnpm --filter @ztab/api test:e2e       # e2e: real PostgreSQL + stub watcher
```

From the repo root: `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @ztab/api test:e2e`, `cd watcher && cargo test`.

`test/crypto-contract.e2e-spec.ts` imports the real `@ztab/crypto` package (a workspace dev-dependency exporting TypeScript source) under the same ts-jest ESM setup as every other suite. The API tsconfig sets `allowImportingTsExtensions` and `noEmit` for type checking and the editor, and `tsconfig.build.json` turns both back off for `nest build`. No special runner is needed. The suite derives keys, seals blobs and hashes tokens exactly as the browser does, and also pins the `ztab/v1/token` derivation to `crypto/test/fixtures/hkdf.json`.

## Privacy rules

Logs carry only method, path, status, duration and error code. Request and response bodies, `Authorization`, blobs, addresses, amounts, txids, UFVKs and token hashes are never logged. Blobs are opaque to the API. URL fragments never reach it. An unknown tab and a foreign token answer identically, and `GET /status` says nothing about tabs. Do not weaken any of this; see spec section 9.

## Polling

There is no push. The PWA polls `GET /tabs/:id` (every 10 s, 5 s on the participant screen after paying). The API calls the watcher on demand and caches its tab snapshot for 5 s in process memory; sweep and broadcast invalidate that cache. Rate limits default to 10 `PUT /tabs` per hour and 120 other requests per minute (`RATE_LIMIT_CREATE_PER_HOUR`, `RATE_LIMIT_DEFAULT_PER_MINUTE`), per client IP, with exactly one proxy in front (the IP comes from `X-Forwarded-For`; the API logs a one-time warning when the header is missing).

## Contract notes for the PWA

Behaviour fixed during implementation, beyond the spec text:

- Unexpected server errors return 500 with error code `internal` (no details).
- Watcher 401 or 403 (the API's own `WATCHER_TOKEN` is wrong) is reported as `503 watcher_unavailable`, not passed through.
- In `GET /tabs/:id`, `status_facts: null` means unknown (no watcher data for that index), not "nothing paid".
- `stale` is `true` when the watcher is unreachable or when the watcher itself reports `stale` (it then serves its last known facts, and `synced_height`/`tip_height` are present).
- A participant link's view also carries `participant_index`.
- `recipient_address` must start with the network's unified-address prefix (`utest1` on `test`, `u1` on `main`), at most 512 characters. `pczt_b64` is 256 to 49152 characters of base64url or standard base64. Anything shorter or differently shaped (for example a 43-character secret) is `400 validation`.
- If the watcher returns addresses that do not match the request (count, indexes, network prefix), `PUT` answers `503 watcher_unavailable` and stores nothing.
- A `GET` that finds the watcher inactive while the tab is not paused re-activates it (best effort, never fails the read).
- Retrying `PUT /tabs/:id` (row exists) requires `Authorization: Bearer <admin token>` and an identical token-hash set (and same `ufvk`, mode, count, birthday); otherwise `409 conflict`.
- Rate limits are per client IP and assume one trusted proxy hop.
- `ZTAB_DISABLE_CRON` exists for tests only.
