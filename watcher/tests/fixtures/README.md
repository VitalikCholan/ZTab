# Test fixtures

## Files

| File | What it is |
|---|---|
| `fixture-ufvk.txt` | Testnet UFVK of the spike's view-only wallet (a viewing key, not a secret). Live tests register it as a tab. |
| `birthday_treestate.bin` | Tree state at that wallet's birthday, so offline tests can import it without the network. Refreshed by the ignored live test `fetch_mempool_fixtures`. |
| `*.rawtx` | Raw testnet transactions to and from the fixture account, named by the first 8 hex digits of the txid (see `tests/common/mod.rs`). |
| `sweep.proved.pczt`, `sweep.signed.pczt`, `sweep2.proved.pczt` | PCZTs from the spike's sweeps. Both transactions are already mined. They contain no keys. |

## The fixture payer (`ZTAB_TEST_SEED_HEX`)

The end-to-end test `full_tab_lifecycle_on_testnet` pays a tab from a real testnet wallet
(`common::FixtureWallet`). That wallet is restored from a 32-byte seed held in the
environment variable `ZTAB_TEST_SEED_HEX`. It lives in a temp dir and scans from
`ZTAB_TEST_PAYER_BIRTHDAY`, which defaults to `common::PAYER_DEFAULT_BIRTHDAY`.

**Never commit the seed.** Keep it in the environment, in a CI secret, or in a git-ignored file
such as `.superpowers/…/test-seed.hex`. It spends real (testnet) funds, and anyone who has it
can drain the payer.

Each run moves 0.02 TAZ to the tab and sweeps it back to the payer, so it costs two
ZIP 317 fees of 0.0001 TAZ each. One faucet claim of 1 TAZ is enough for thousands of runs.
A run that fails after the payment and before the sweep loses its 0.02 TAZ: the tab's key
is random and is dropped when the run ends.

### Create and fund a payer

1. Generate a seed and keep it out of the repo:
   ```sh
   export ZTAB_TEST_SEED_HEX=$(openssl rand -hex 32)
   ```
2. Derive the payer's address. This runs offline:
   ```sh
   cargo test --test testnet_live fixture_payer_address -- --ignored --nocapture
   # payer address: utest1…
   ```
3. Claim 1 TAZ for that address at <https://fauzec.com> (one claim per 24 h):
   ```sh
   curl -X POST https://fauzec.com/api/v1/claim -H 'Content-Type: application/json' \
     -d '{"network":"testnet","address":"utest1…"}'
   curl https://fauzec.com/api/v1/status/testnet/<request_id>   # until "state":"confirmed"
   ```
   The status response includes `confirmed_height`.
4. Set the birthday to a height a little below the claim's `confirmed_height`, for example
   `confirmed_height - 10`. Scanning then takes seconds:
   ```sh
   export ZTAB_TEST_PAYER_BIRTHDAY=<confirmed_height - 10>
   ```
   For the payer this repo was tested with, the default `PAYER_DEFAULT_BIRTHDAY` already
   matches its claim.
5. Wait until the claim has 10 confirmations (about 5 minutes; ZIP 315 requires this
   before an external note can be spent). The test also waits up to 10 minutes for the
   funds to become spendable.
6. Run the scenario (about 5 minutes; up to ~15 with slow blocks):
   ```sh
   cargo test --test testnet_live full_tab_lifecycle -- --ignored --nocapture
   ```
   The test prints the payer's balance at the start and the end.

### Refill

The test fails early with "the fixture payer needs >= 0.021 TAZ; refill it" when the
balance runs low. To refill, claim again for the same address (step 3). The birthday does
not change, because the wallet scans every block from its birthday on. If you want a fresh
payer instead, repeat every step with a new seed and birthday.
