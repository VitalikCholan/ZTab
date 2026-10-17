# ZTab privacy invariants (a leak is a disqualification, not a lost point)

Any change that violates one of these is a bug even if it makes a feature easier.

1. **The server never holds spending authority.** Browser generates the tab's master key; server receives only the tab's UFVK. Closing a tab = server creates + proves the PCZT, browser signs. Never ship a spending key, mnemonic, or Orchard `SpendingKey` to the API, logs, or analytics.
2. **Key material travels only in URL fragments** (`#...`), never in path, query, headers, cookies, or server-rendered HTML. Per-participant keys are derived with HKDF from the master key; the server stores ciphertext blobs only.
3. **No transparent hops.** Pay-in is shielded-to-shielded; the sweep goes to a UA with a shielded receiver. Cross-chain via NEAR Intents is out of scope because it delivers ZEC to transparent addresses only. Transparent-source payments are detected and flagged, never requested.
4. **One diversified address per participant** so the watcher can attribute payments; never reuse a participant address across tabs.
5. **"Paid" requires block confirmations.** Mempool is a hint. A hostile indexer can show a transaction that does not exist.
6. **The demo runs on our own Zebra + lightwalletd**; a public indexer learns which addresses we watch. Watcher traffic on mainnet goes through Tor (`zcash_client_backend` `tor` feature).
7. **Receipt triggers nothing on-chain** (ZIP 315). No auto-sweep; only a prompt to the payer.
8. **Group-link mode reveals all shares to everyone holding the link; individual-link mode reveals only the participant's own share.** Never generate both for the same tab.
9. **Document, do not hide.** README threat model (Zodl ICTM format, adversary tiers) must list every known weakness: modified JS from a compromised server (mitigated by SRI + static frontend), link visible to the messenger's servers, amounts of active tabs visible to the server.

## Closing-PCZT invariant between watcher and browser (2026-10-16)
- The browser module (`crypto/rust/src/pczt_ops.rs::sign`) signs a sweep only if every value-carrying Ironwood output is recoverable with the tab's **External-scope OVK** and decrypts to the expected receiver and value. The watcher therefore must keep building sweeps with `OvkPolicy::Sender` (`watcher/src/sweep.rs`); changing the OVK policy breaks closing for every tab, so treat it as a protocol change between the two subprojects.
