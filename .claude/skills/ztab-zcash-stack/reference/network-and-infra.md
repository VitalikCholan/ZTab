# Zcash network and infrastructure facts (verified 2026-10-15)

## Network upgrades
| Upgrade | Mainnet | Testnet | Branch ID | What it means for ZTab |
|---|---|---|---|---|
| NU6.3 (Ironwood pool, ZIP 2005/229) | active @3428143 | active @4134000 | 0x37A5165B | Wallets MUST NOT send to the Orchard pool any more (ZIP 326). Every incoming payment is an **Ironwood** note. Orchard receivers in UAs keep working; no new address type. |
| NU7 (ZIP 218 25 s blocks, ZIP 2003 no v4 tx, fee changes) | height to be set 2026-10-20, target 2026-11-05 | **active @4465026 since 2026-10-04** | 0x77190AD9 | Testnet already runs NU7. Transactions built with crates that do not know the NU7 testnet height carry the NU6.3 branch id and are rejected. |

- Testnet tip was ~4503700 on 2026-10-15. Observed block interval 30–35 s (target 25 s). Default tx expiry after NU7: 120 blocks.
- `testnet.zcashexplorer.app` is STALE (stuck at 4331234 on Zebra 6.3.0). Check the tip with `GetLatestBlock` on lightwalletd instead.

## Public testnet server (use during development)
- `https://testnet.zec.rocks:443` — Zebra 7.0.0-rc.0 + lightwalletd 0.5.4, lightwallet-protocol 0.5.0. `GetMempoolStream` works. Raw gRPC over HTTP/2 with curl is enough for probes (empty 5-byte frame).

## Own indexer for the judges' deploy
- Zebra **7.0.0-rc.0 or later** (docker `zfnd/zebra:7.0.0-rc.0`, amd64+arm64). 6.4.x stalls at 4465025 on testnet.
- lightwalletd **v0.5.5** (docker `electriccoinco/lightwalletd:v0.5.5`, amd64 only). Zebra RPC needs `ZEBRA_RPC__ENABLE_COOKIE_AUTH=false`. Start from `docker/docker-compose.lwd.yml` in the Zebra repo; switch to testnet: `ZEBRA_NETWORK__NETWORK=Testnet`, ports 18233/18232, remove the 16 GB memory reservations on an 8 GB Docker Desktop.
- **Zaino is NOT NU7-ready** (zingolabs/zaino PR #1655 open, "do not merge, blocked on dependency"). Do not plan on it for testnet in October 2026.
- Testnet state ~10 GB. Snapshots at https://snapshots.zfnd.org/testnet/snapshots.json (10.9 GiB, extract into the `zebrad-cache` volume with a throwaway alpine container; verify sha256 first). A snapshot node reaches the tip in minutes; genesis sync is half a day.

## TAZ faucets
- https://fauzec.com — 1 TAZ / 24 h, UA first, API: `POST /api/v1/claim {"network":"testnet","address":"utest1..."}` then `GET /api/v1/status/testnet/{request_id}`. Measured: note confirmed ~7 min after the claim.
- https://faucet.testnet.valargroup.dev — 0.125 TAZ / IP / 24 h.
- zcashfaucet.jinolabs.xyz paused (Zallet has no NU7 build). faucet.zecpages.com is dead.

## Mobile wallets (verified from app repositories 2026-10-15; no hand test yet)
Zcash has no OS-level support; it is an app per platform. Shielded mobile wallets exist for **iOS and Android only**.

| Wallet | iOS | Android | `zcash:` deep link | Testnet available to a judge | NU7 crates |
|---|---|---|---|---|---|
| Zingo | App Store 2.0.24 (Sep 25, pre-NU7); **Beta via TestFlight External** | Play Open Testing + GitHub APKs (beta 2.0.23-340, 2026-10-15) | yes, both OSes (`zcash` scheme in manifest and Info.plist) | yes: in-app chain toggle + custom server (`ChainTypeToggle`) | beta = zingolib dev (NU7 cohort) |
| Zkool (ywallet successor) | **no iOS build** | GitHub APK 6.34.0; also macOS/Windows/Linux desktop | **no** `zcash` scheme (Android has only https app-links); QR scan only | custom lightwalletd URL in settings; network follows the server (`get_network_name`), unverified | 6.33.0 integrated NU7 deps |
| Zodl (ex Zashi, ECC) | App Store | Play + GitHub APK 3.17.0 | yes (Android manifest `zcash`; iOS deeplink + ZIP 321 scan code) | **no**: testnet flavors exist in source (`zcashtestnet*`, "Zodl Testnet" target) but are not published; mainnet-only builds | Android: Zodl's SDK fork 5.1.0 (2026-10-07) builds on the NU7 pre-release crates, so 3.16+ is likely NU7-capable; iOS SDK fork: not stated |
| Edge, Cake | yes | yes | unknown | no (mainnet only) | unknown |
| Keystone | hardware signer, not a phone wallet | | | | |

Consequence for the demo: a judge with an iPhone needs **Zingo Beta from TestFlight**; with Android, Zingo beta APK or Zkool APK (Zkool needs QR, not a link). Zodl cannot be used on testnet without building it from source. Official SDKs (what third-party wallets build on): zcash-swift-wallet-sdk 3.0.0 (Ironwood, 2026-08-29) and zcash-android-wallet-sdk 3.0.0 (Ironwood, 2026-08-25; a v4.0.0 tag exists without release notes). Neither official SDK mentions NU7 yet. Zodl uses its own forks: zodl-swift-wallet-sdk 5.0.0, zodl-android-wallet-sdk 5.2.0 (NU7 pre-release crates since 5.1.0). ZTab does not use these SDKs; they only predict which wallets will work on testnet.
