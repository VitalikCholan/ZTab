# ZTab

![CI](https://github.com/VitalikCholan/ZTab/actions/workflows/ci.yml/badge.svg)

**A private bill splitter on shielded Zcash.** One person opens a tab, sends each friend a link, everyone pays their share in shielded ZEC, and the organizer withdraws the total. The server never learns who the participants are or what the tab is for, and it never holds a key that can move the money.

**Live demo (Zcash testnet):** https://ztab.dev

Built for ZECATHON 2026, track **Shielded Payments**.

## Try it

You need a Zcash **testnet** wallet with shielded (Orchard) sends and a little testnet ZEC (TAZ).

1. Get a wallet and TAZ. Tested on 2026-10-25: **Vizor Testnet** on macOS (the separate `Vizor-Testnet-macos.dmg` from `chainapsis/vizor-wallet` releases; the plain Vizor app is mainnet) paid a tab and received the withdraw. **Zingo** from the App Store on iPhone (switched to Testnet) now shows testnet funds; paying from it is not tested yet. The faucet is https://fauzec.com.
2. Open https://ztab.dev and create a tab: a title, a total in USD, the participants' names, a mode, and your own shielded address to withdraw to.
   - **Group:** one link for everyone; everyone sees everyone's status.
   - **Individual:** one link per person; each sees only their own share.
3. Save the **admin link** (it is the only way back to the tab and its funds), then open a participant link.
4. Pay from your wallet by scanning the QR code or opening the `zcash:` link. The payment shows as seen within seconds of reaching the mempool and as **paid** after 3 confirmations.
5. Back on the admin page, once a payment has 10 confirmations (a few minutes on testnet), press **Withdraw**, check the summary (it shows where the transaction really sends the money) and confirm. The funds arrive in your wallet as one shielded transaction. The rest stays on the tab (the dialog says how much): younger notes and notes past the 50-note cap can be withdrawn later; notes of 5 000 zat or less are never swept by the app (recoverable only with the admin link, outside the app).

## How it works

```mermaid
flowchart LR
  subgraph Browser
    PWA["PWA + @ztab/crypto (wasm)<br/>keys, encryption, signing"]
  end
  subgraph VPS["One VPS (Docker Compose)"]
    Caddy["Caddy<br/>TLS, static files, /api proxy"]
    API["API (NestJS)<br/>opaque blobs, hashed tokens"]
    DB[("PostgreSQL")]
    Watcher["Watcher (Rust)<br/>view-only accounts, proofs"]
  end
  LWD["lightwalletd<br/>testnet.zec.rocks"]
  PWA -- HTTPS --> Caddy --> API --> DB
  API --> Watcher --> LWD
```

- **Keys live in the link.** Creating a tab makes a random master key in the browser. Every other key (the tab's Zcash account, the encryption keys, the access tokens) is derived from it with HKDF. The admin link carries the master key in the URL fragment (`#a=…`), participant and group links carry only what they need (`#p=…`, `#g=…`) plus a 16-byte commitment to the blob they open. Browsers never send fragments to a server, and the app removes them from the address bar after reading.
- **One shielded address per participant.** Each participant pays to their own diversified Orchard address of the tab's account, so payments are told apart without memos and without linking participants on chain.
- **The server stores ciphertext.** Title, names and USD amounts are sealed with AES-256-GCM in the browser; so is the withdraw address until the organizer withdraws (see below). The API stores those blobs, SHA-256 hashes of the access tokens, and the tab's lifecycle state. Payment requests carry the constant message `ZTab share`, so the title and names never reach a payer's wallet.
- **The watcher can see, not spend.** It imports each tab as a view-only account from its unified full viewing key (UFVK) and reports payments per address.
- **Withdraw is split by role.** The browser sends the organizer's address to the watcher, which builds and proves a PCZT that sweeps the tab's notes with at least 10 confirmations (at most 50 per sweep) to that address; the browser inspects it, re-checks recipient, amount and fee against what the organizer confirmed, and only then signs it with the spend key from the admin link. The watcher checks the signed PCZT and broadcasts it.

## Privacy model

| The server can learn | The server never learns |
|---|---|
| That a tab exists, its mode and participant count | Title, names, the USD total and shares (it does see the ZEC that arrives) |
| Incoming shielded payments to the tab's addresses (through the UFVK) and their confirmations | Who paid: payers send from their own shielded wallets |
| When the tab is withdrawn, and the withdraw address and amount: the browser sends the address to the watcher to build the sweep, and the output is recoverable with the OVK derived from the UFVK | The spend key or the master key |
| In individual mode, which network client (IP, timing) opens which participant's link, and so which slot's payments it may relate to. Logs do not record IPs, but an active operator could | Access tokens at rest: the database stores only their SHA-256 hashes (a raw token travels in the `Authorization` header of each request) |

What enforces it:

- Payments and the withdraw are shielded (Orchard); no transparent hop.
- A compromised server running the code we ship cannot redirect payments: at creation the PWA checks the watcher's participant addresses against its own derivation, and a group or participant page refuses any blob that does not hash to the commitment in its link, so even a server that holds a reader link cannot swap the address in it. It cannot redirect the withdraw: `signPczt` refuses any PCZT that pays someone else, a different amount, or a higher fee (capped).
- No third-party requests from the browser (fonts, icons, QR and exchange rate are local or go through our API), no cookies, no analytics, `document.title` is always `ZTab`, no console output in production.
- Strict Content-Security-Policy without `'unsafe-eval'`, HSTS, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: no-store` on every API response; the Caddy error log drops URIs, headers and IPs, and there is no access log.
- Tested: an end-to-end test records every request while it creates a tab, opens a group or participant link and opens the admin page, and asserts that no fragment or key, no title, name or USD amount, and no UFVK outside the one registration request leaves the browser. It does not cover paying or withdrawing.

Trade-offs and limits we accept:

- The server holds each tab's viewing key, so it sees amounts arriving at a tab (but not who sent them or what they are for). That is what lets the app show live payment status without the organizer running a wallet.
- The demo watcher uses the public lightwalletd `testnet.zec.rocks` and fetches transactions by txid, so that server's operator can see which txids concern tabs. On mainnet the watcher would use its own lightwalletd or Tor.
- Anyone holding a link sees what it opens; a link shared in a messenger is visible to whoever can read that chat.
- A tab nobody opens for 30 days is deleted from the API database and paused at the watcher, but the watcher keeps its UFVK, payment facts and withdraw records (sweep history and the sweep transaction).
- A compromised server could serve modified JavaScript that leaks the fragment. That is the limit of any web app.

## Repository

| Package | What it is |
|---|---|
| [`pwa/`](pwa/README.md) | React progressive web app |
| [`crypto/`](crypto/README.md) | `@ztab/crypto`: key derivation, encryption, PCZT inspection and signing (Rust + wasm, TypeScript) |
| [`api/`](api/README.md) | NestJS API with PostgreSQL |
| [`watcher/`](watcher/README.md) | Rust service: view-only accounts, payment facts, PCZT sweeps |
| [`deploy/`](deploy/README.md) | Docker Compose, Caddy, server scripts and runbook |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Design specs (Ukrainian) |

Stack: Rust 1.98 with librustzcash (NU7/Ironwood pre-release crates), wasm-bindgen, NestJS 12, Prisma 7, PostgreSQL 16, Vite 8, React 19, Tailwind 4, Caddy 2, Docker Compose.

## Run and test

Node 24, pnpm 11, Rust 1.98 and Docker.

```sh
pnpm install
pnpm -r typecheck && pnpm -r test     # TypeScript and Vitest suites
(cd watcher && cargo test)            # Rust; live testnet tests are #[ignore]d
bash deploy/rehearsal.sh              # the production stack on https://localhost + Playwright smoke
```

Each package README has its own run instructions. CI runs all of the above on every push and pull request, and publishes the images to GHCR (`ghcr.io/vitalikcholan/ztab-{api,watcher,pwa}`). To deploy your own copy, follow [`deploy/README.md`](deploy/README.md).

## Status and limits

- Testnet only. Mainnet needs the NU7 crates to be released and a security review.
- Payers need a wallet that sends shielded ZEC and handles `zcash:` (ZIP-321) requests; wallet support on testnet after NU7 is still uneven.
- A tab nobody opens for 30 days is deleted from the API database and paused at the watcher (which keeps its UFVK, payment facts and withdraw records). Funds that arrive later stay on the tab key and can be recovered only with the admin link, outside the app.
- A withdraw takes notes with at least 10 confirmations worth more than 5 000 zat, at most 50 per sweep; the rest stays on the tab: younger notes and notes past the 50-note cap can be withdrawn later; notes of 5 000 zat or less are never swept by the app (recoverable only with the admin link, outside the app).
- The demo depends on a public lightwalletd (`testnet.zec.rocks`), which sees which txids concern tabs; it can be switched in `deploy/.env` without a code change.
