# @ztab/pwa

Vite 8 + React 19 progressive web app for ZTab, a private bill splitter on shielded Zcash. All key derivation, encryption and PCZT signing happen in the browser through `@ztab/crypto` (wasm); the API only ever sees opaque blobs and hashed tokens. Participants pay by QR or `zcash:` link, and the admin withdraws the collected funds from the admin page.

Design: [`docs/superpowers/specs/2026-10-18-ztab-pwa-design.md`](../docs/superpowers/specs/2026-10-18-ztab-pwa-design.md).

## Run

Requires Node 24 and pnpm 11 (see the root `package.json`). The API must be reachable at `VITE_API_URL` (see [`api/README.md`](../api/README.md)).

```sh
pnpm install
cp pwa/.env.example pwa/.env           # then edit
pnpm --filter @ztab/pwa dev            # http://localhost:5173
pnpm --filter @ztab/pwa build          # production build into pwa/dist
pnpm --filter @ztab/pwa preview        # serve the build on :4173
```

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `VITE_API_URL` | yes | `http://127.0.0.1:3000` (in `.env.example`) | Base URL of the ZTab API: absolute, or a path such as `/api` (resolved against the page origin; used behind a reverse proxy) |
| `VITE_NETWORK` | yes | `test` (in `.env.example`) | `test` or `main` |
| `VITE_EXPLORER_TX_URL` | no | empty | Block explorer tx link prefix, e.g. `https://explorer.example/tx/` |
| `VITE_DEMO_PAYMENT` | no | unset | Reserved, leave unset |
| `VITE_HTTPS` | no | unset | `1` serves the dev server over self-signed HTTPS (`vite.config.ts`) |

`VITE_*` values are baked into the bundle at build time.

## Container

`pwa/Dockerfile` builds the bundle and ships it as a one-shot image: on start it empties `/srv/pwa` (a mounted volume), copies the built files into it, prints `pwa: dist copied (<n> files)` and exits. A web server container serves the same volume. Build from the repo root:

```bash
docker build -f pwa/Dockerfile --build-arg VITE_API_URL=/api --build-arg VITE_NETWORK=test -t ztab-pwa .
docker run --rm -v pwa-dist:/srv/pwa ztab-pwa
```

`VITE_EXPLORER_TX_URL` is an optional build arg. The committed `crypto/pkg` wasm is used as is; it is not rebuilt in the image.

## Test

```sh
pnpm --filter @ztab/pwa typecheck
pnpm --filter @ztab/pwa test           # Vitest, unit and component tests
pnpm --filter @ztab/pwa e2e            # Playwright against the real API and a stub watcher
```

End-to-end prerequisites: Docker Desktop running, and the Playwright browser installed once with `pnpm --filter @ztab/pwa exec playwright install chromium`. The harness (`e2e/harness/start.ts`) does the rest: it starts the API's test PostgreSQL (`pnpm --filter @ztab/api db:up`), creates a fresh `ztab_e2e` database, builds and starts the real API on :3000, starts a stub watcher, and Playwright builds and serves the PWA on :4173. Logs go to `e2e/.harness/`.

The scenarios prove:

- boot: wasm loads, the app talks only to localhost, and the built `index.html` has no inline code (`smoke.spec.ts`);
- a group tab and an individual tab go through create, links, payment seen and paid, and the admin withdraw, with a tampered summary blocking confirmation and a PCZT for another key failing with `pczt_mismatch` with nothing broadcast (`create-pay-withdraw.spec.ts`);
- privacy: every request of the create, links, participant, group and admin flow is recorded and searched for the URL fragments, their keys and the UFVK, and none leaves the browser (`privacy.spec.ts`).

The real watcher and chain are not involved; the live testnet run is still to be recorded (see below).

## Phone testing over HTTPS

WebCrypto (`crypto.subtle`) only exists in a secure context, so a phone cannot open the dev server over plain `http://<lan-ip>`. Serve it over HTTPS:

```sh
VITE_HTTPS=1 pnpm --filter @ztab/pwa dev --host
```

Open `https://<lan-ip>:5173` on the phone (same Wi-Fi). `@vitejs/plugin-basic-ssl` issues a self-signed certificate, so the browser shows a certificate warning: accept it (Safari: Show Details, visit this website; Chrome: Advanced, Proceed). `VITE_API_URL` must be reachable from the phone, so set it to the computer's LAN address rather than `127.0.0.1`, and allow that origin in the API's `CORS_ORIGIN`. An HTTPS page cannot call a plain-HTTP API (mixed content), so for a phone run the API behind HTTPS too, or use a tunnel.

## Privacy rules

Mirrors spec section 9. A privacy leak is the failure mode that matters here.

| Rule | Enforced by |
|---|---|
| Fragment keys (`#a=`, `#g=`, `#p=`) never reach a request and are removed from the address bar after reading | Browsers do not send fragments; `window.history.replaceState` in `src/pages/TabEntry.tsx`; checked in `e2e/privacy.spec.ts` |
| Keys and tokens live in memory only; no cookies, IndexedDB or session storage | The only storage write is the flag below |
| The only stored item is `localStorage` `ztab.adminWarningSeen` (value `1`) | `src/pages/Links.tsx` |
| No third-party hosts: system fonts, inline icons, QR drawn locally on a canvas, exchange rate via our API | `qrcode` in `src/components/QrCode.tsx`; the smoke e2e asserts only localhost is contacted |
| `document.title` is always `ZTab`; names, amounts and statuses never appear in it | Static `<title>` in `index.html`; nothing in `src` assigns it |
| No console output in production | `build.rolldownOptions.output.minify.compress` (`dropConsole`, `dropDebugger`) in `vite.config.ts` |
| The service worker caches build assets only, never API responses or tab pages | Workbox precache with no `runtimeCaching` and `navigateFallbackDenylist: [/^\/t\//]` in `vite.config.ts` |
| Outbound links use `rel="noopener noreferrer"`; the page sends no referrer | `index.html` `<meta name="referrer" content="no-referrer">` |

## Reverse-proxy headers

The Caddy in [`deploy/`](../deploy/README.md) (`deploy/Caddyfile`) sets these on everything it serves from `pwa/dist`; this app sets none itself. HSTS is sent only when `DOMAIN` is a real domain (not `localhost`, not `*.sslip.io`), so a throwaway host is never pinned.

```
Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Strict-Transport-Security: max-age=31536000
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
X-Content-Type-Options: nosniff
```

`connect-src 'self'` is enough because the API is served from the same origin under `/api` (`VITE_API_URL=/api`). The CSP has no `'unsafe-eval'`: `src/zod-config.ts` sets zod's `jitless` mode, because zod's JIT probe would otherwise raise a CSP violation.

Policy verified by reading the build output (`pnpm --filter @ztab/pwa build`): `dist/index.html` has one external module script, the PWA `registerSW.js` script and a linked stylesheet, with no inline script or style, and `src` has no `style=` props, so `style-src 'self'` suffices and `'unsafe-inline'` is not needed. `'wasm-unsafe-eval'` is required in `script-src` to compile the `@ztab/crypto` wasm. The service worker (`sw.js`) is covered by `script-src 'self'` via the `worker-src` fallback. The QR is a canvas, so `img-src data:` is only a safety margin. It is also checked in a real browser under this header by the deploy smoke test (`deploy/smoke/stack.spec.ts`): wasm boots and the service worker registers.

## Wallet compatibility

State as of 2026-10-18:

- Zingo from the App Store (2.0.24, built before NU7 activated on testnet) switches to Testnet and syncs, but does not show testnet funds received after NU7. Update 2026-10-25: the current App Store build shows those funds; sending from it is not tested yet.
- Vizor Testnet (desktop, `chainapsis/vizor-wallet`, handles the `zcash:` scheme) is a separate build (`Vizor-Testnet-macos.dmg`); the plain Vizor app is mainnet. Tested 2026-10-25: received from the faucet and paid a ZTab tab, and received the withdraw.
- Testnet faucet: https://fauzec.com (1 TAZ per day; has "Copy as zcash: link").
- `zcash:` deep links opening a wallet on phones are desirable but unverified. The QR code and the copy buttons are always available.

## Data retention

A tab nobody opens for 30 days is deleted (API purge rule). Its links stop working, and funds that arrive later stay on the tab key; they can be recovered only with the admin link, outside the app. Keep the admin link.

## Manual testnet run

2026-10-25, https://ztab.dev (Hetzner CPX12, 1 vCPU, 2 GB), images `sha-2f76499`:

1. Created a $5 group tab with two participants ($2 and $3) on iPhone Safari, with a Vizor Testnet address for the withdraw.
2. Paid the two shares as separate transactions from Vizor Testnet (macOS). Both showed **Paid**; the Withdraw button became ready once every payment had 10 confirmations.
3. Withdraw from the admin page on the iPhone: the watcher built and proved the sweep in 8.8 s, the phone signed it in the browser (wasm), the broadcast took 3.7 s, and the tab moved to `closed` after 10 confirmations (about 3.5 minutes). The funds arrived in Vizor.

The first attempt failed with `watcher_unavailable`: the API waited 5 s for the sweep while proving takes about 9 s on one vCPU. Sweep now has its own 60 s timeout (`api/src/watcher/watcher.client.ts`).
