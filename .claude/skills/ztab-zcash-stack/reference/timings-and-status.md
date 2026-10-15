# Measured timings on post-NU7 testnet (2026-10-15, testnet.zec.rocks)

| Measurement | Result |
|---|---|
| `init-fvk` + `sync` of a view-only account whose birthday is 133 blocks behind the tip | 0.55 s wall |
| Payment visible in server mempool after broadcast | ≤ 14 s |
| Payment mined | 35 s best case, ~3 min worst case seen |
| Light wallet shows the note after `sync` | ≤ 55 s after broadcast |
| 3 confirmations | ~1.5–2 min |
| 10 confirmations (ZIP 315 untrusted TXO spendable) | ~7 min |
| PCZT `create-max` / `prove` / `sign` / `send` on a 2-action Ironwood tx | 25 ms / 1.4 s / 1.4 s / 1.1 s; proved PCZT 12 KB |
| Sweep tx mined after broadcast | 72 s – 2 min |

## Status rules (from ZIP 315 + measurements)
- **Pending**: no note for the participant's address.
- **In mempool**: decrypted from `GetMempoolStream`. Informational only. Never store "paid" from this.
- **Paid**: note mined with ≥ 3 confirmations (≈ 1.5–2 min). Show the count.
- **Sweepable**: every note ≥ 10 confirmations (≈ 7 min); `pczt create-max` without `--only-spendable` refuses earlier.
- **Paid from transparent**: detected (t-input in the tx) and flagged; it is still money.
- **Reorg**: if a note's block leaves the best chain, revert the status; never show a status the chain no longer supports.
- Receipt of a payment must not trigger any on-chain action (ZIP 315). The sweep is always a user action by the payer.
- Keep block counts and the block interval in config, not code: mainnet is still 75 s until NU7 activates there.

## Mempool stream semantics (lightwallet protocol, not re-measured)
`GetMempoolStream` streams current mempool transactions and **closes when a new block is mined**. The watcher must re-subscribe after every block (and after any transport error) and must treat a closed stream as "re-sync blocks, then re-subscribe", not as "mempool empty". Trial-decrypt each streamed tx with the tab's UFVK; a hit yields the participant's diversifier index.
