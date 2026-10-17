# Fixtures

- `spend_seed.hex`, `expected.json`: a deterministic tab. The seed is
  `HKDF-SHA256(master = 00…1f, salt = "0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70", info = "ztab/v1/spend")`,
  the same vectors as `crypto/test/fixtures/hkdf.json`; the UFVK and the addresses at indices
  0, 1, 7 were derived natively with the pinned crates. The seed owns nothing on any network.
- `tab/`: one real throwaway tab from a run of the watcher's `full_tab_lifecycle_on_testnet`
  with `ZTAB_TEST_DUMP_DIR` set (see `watcher/tests/fixtures/README.md`). `sweep.proved.pczt`
  is the watcher's proved closing PCZT for that tab; `spend_seed.hex` signs it; `expected.json`
  is what `inspect` must report. The tab's funds were swept back to the payer in that run, so
  the seed is public and worthless. Regenerate all three together, never one of them.
- Watcher PCZTs used read-only: `../../watcher/tests/fixtures/sweep*.pczt` (no key for them
  exists any more; they exercise inspection and the negative signing paths).
