# ZTab security fixes (audit run-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audit's confirmed issues (forgeable reader blobs, withdraw blocked by young/dust notes), neutralise the ZIP-321 message, and make README's privacy model match the code.

**Architecture:** Reader links (`#g=`, `#p=`) gain a 16-byte commitment to their blob's content (SHA-256 of a canonical JSON of the schema-parsed blob); reader pages refuse a blob whose commitment differs. The watcher sweeps only deep notes worth more than their marginal fee, at most 50 per sweep, and reports what it left; the API passes the new numbers through; the PWA gate and dialog use them. README and the project's privacy invariants are rewritten to state exactly what the server learns.

**Tech Stack:** TypeScript (`@ztab/crypto` TS layer, WebCrypto), React 19 PWA + Vitest + Playwright, NestJS API + Jest, Rust watcher (zcash_client_backend `=0.25.0-pre.1`).

**Spec:** `docs/superpowers/specs/2026-10-25-ztab-security-fixes-design.md` (Ukrainian). Read it first.

## Global Constraints

- Shell prefix: `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/pnpm:$PATH"`. Never print or reference `~/.config/ztab/*`. Never log or commit tokens, UFVKs, link fragments, addresses, amounts from real tabs.
- Branch `security/audit-fixes` (already created from `main` at `0bfa83b`). One PR. Never push to `main`, never force-push. Commit trailers from the session attribution reminder.
- Old links may break; no compatibility path for fragments without a commitment (spec §2.2).
- ZIP-321 message is exactly `ZTab share` (spec §2.3).
- Do not change `crypto/rust`, `crypto/pkg`, `pczt_ops.rs` checks, `MAX_FEE_ZAT` (500 000), or `OvkPolicy::Sender`.
- No new npm or crate dependencies.
- The only new UI copy is the withdraw leftover line (Task 6). Commitment failure reuses the existing "Address mismatch, do not pay" UI.
- Untracked owner files `pwa/.agents/`, `pwa/.claude/`, `pwa/skills-lock.json`, `skills-lock.json`, `.claude/skills/security-audit/` are never staged. Stage files by explicit path only.
- Before push: `pnpm --filter @ztab/crypto test && pnpm --filter @ztab/api test && pnpm -r typecheck && pnpm --filter @ztab/pwa test && pnpm --filter @ztab/pwa e2e && pnpm --filter @ztab/pwa build && (cd watcher && cargo test)`.

## Review Focus

1. A reader link with a valid key but a commitment for a different blob (e.g. the admin re-shared an old link after the blob changed): page must show the mismatch state, never a Pay button. Pinned in Task 3 (`group page with wrong commitment shows mismatch and no Pay`).
2. Admin re-issues links on a tab created before this change (blob present, no commitment ever printed): re-issued links must open and verify. Pinned in Task 2 (`adminLinks output verifies against blobs built at creation`).
3. Tab with only young notes plus one deep dust note (≤ 5 000 zat): gate must say wait/nothing, not ready (a ready button that 409s is the bug). Pinned in Task 5 (`plan_sweep_ignores_dust`) and Task 6 (`gate waits when sweepable is zero but spendable is not`).
4. Exactly 50 vs 51 eligible deep notes: fee stays below `MAX_FEE_ZAT` and the 51st is reported as remaining. Pinned in Task 5 (`plan_sweep_caps_inputs_at_50`).
5. Participant whose blob title/name contains characters that changed under JSON canonicalisation (unicode, quotes, emoji): commitment computed at creation equals the one recomputed on the reader page. Pinned in Task 1 (`blobCommit is stable across key order and unicode`).

---

### Task 1: Commitment primitive and fragment format (`@ztab/crypto`)

**Files:**
- Create: `crypto/src/commit.ts`
- Modify: `crypto/src/fragment.ts`, `crypto/src/index.ts`
- Test: `crypto/test/commit.test.ts` (new), `crypto/test/fragment.test.ts`

**Interfaces:**
- Produces: `export const COMMIT_BYTES = 16;` and `export async function blobCommit(value: unknown): Promise<Uint8Array<ArrayBuffer>>` — first 16 bytes of SHA-256 over UTF-8 of `canonicalJson(value)`; `canonicalJson` = `JSON.stringify` with object keys sorted recursively (arrays keep order). Exported from `crypto/src/index.ts`.
- Produces: `Fragment` becomes `{ kind: 'admin'; master } | { kind: 'group'; key; commit } | { kind: 'participant'; index; key; commit }` (`commit: Uint8Array`, 16 bytes). Encoding `#g=<key64>.<commit64>`, `#p=<i>.<key64>.<commit64>` (base64url, no padding). `#a=` unchanged.

- [ ] **Step 1: Write failing tests**
  - `commit.test.ts`: `blobCommit is 16 bytes`; `blobCommit is stable across key order and unicode` (`{b:1,a:'Café "x" 🍕'}` and `{a:'Café "x" 🍕',b:1}` give equal bytes); `blobCommit differs when an address changes`.
  - `fragment.test.ts`: round-trip `encodeFragment`/`parseFragment` for group and participant with a 16-byte commit; `parseFragment('#g=<key>')` and `'#p=0.<key>'` (no commit) throw `CryptoError` code `invalid_fragment`; a 15- or 17-byte commit throws `invalid_fragment`; `encodeFragment` with a wrong-length commit throws `internal`. Replace existing group/participant cases that use the old format.
- [ ] **Step 2: Run** `pnpm --filter @ztab/crypto test` — new tests FAIL.
- [ ] **Step 3: Implement** `commit.ts` with `crypto.subtle.digest('SHA-256', …)`; extend `fragment.ts` regexes (`^(0|[1-9]\d{0,9})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$` for `p`, `^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$` for `g`).
- [ ] **Step 4: Run** `pnpm --filter @ztab/crypto test && pnpm --filter @ztab/crypto typecheck` — PASS.
- [ ] **Step 5: Commit** `crypto: commit reader links to their blob content`

### Task 2: Links carry the commitment (create + admin re-issue)

**Files:**
- Modify: `pwa/src/tab/blobs.ts`, `pwa/src/tab/create.ts`, `pwa/src/tab/keys.ts`, `pwa/src/pages/Admin.tsx`
- Test: `pwa/test/tab/create.test.ts`, `pwa/test/tab/keys.test.ts`, `pwa/test/pages/Admin.test.tsx`, `pwa/test/pages/Links.test.tsx`, `pwa/test/pages/NewTab.test.tsx` (fixtures only as needed)

**Interfaces:**
- Consumes: `blobCommit`, new `Fragment` (Task 1).
- Produces (in `blobs.ts`): `groupBlobFromAdmin(admin: AdminBlob): GroupBlob` (admin minus `withdraw_address`) and `participantBlobFromAdmin(admin: AdminBlob, index: number): ParticipantBlob` (fields `v,title,index,name,share_cents,share_zat,address,rate_usd_per_zec,mode` from the admin blob and its row). `buildBody` in `create.ts` must build the group/participant blobs through these two functions so creation and re-issue cannot drift.
- Produces (in `keys.ts`): `adminLinks(master: Uint8Array, tabId: string, admin: AdminBlob, origin: string): Promise<{ adminUrl: string; participantUrls: string[] }>` — mode and count come from `admin`; each reader URL carries `blobCommit` of the matching `*FromAdmin` blob. `Session` gains `commit?: Uint8Array` (group/participant only), set by `sessionFromFragment`; `zeroSession` zeroes it.

- [ ] **Step 1: Write failing tests**
  - `create.test.ts`: `group link carries the commitment of the sealed group blob` (parse the created group URL fragment; `commit` equals `blobCommit` of the JSON opened from `body.blobs.group`); same for every participant link in individual mode.
  - `keys.test.ts`: `adminLinks output verifies against blobs built at creation` (create a tab via the existing test helpers, then `adminLinks(master, tabId, adminBlob, origin)` URLs equal the created `participantLinks` URLs); `sessionFromFragment keeps the commitment for group and participant`.
- [ ] **Step 2: Run** `pnpm --filter @ztab/pwa test -- tab/` — FAIL.
- [ ] **Step 3: Implement** the helpers, `buildBody` refactor, link building in `finish` (`create.ts`), `adminLinks` new signature, and `Admin.tsx` call site (pass the decrypted admin blob; effect deps on the blob instead of `mode, n`).
- [ ] **Step 4: Run** `pnpm --filter @ztab/pwa test && pnpm --filter @ztab/pwa typecheck` — PASS (update fixtures that build old-format links).
- [ ] **Step 5: Commit** `pwa: put the blob commitment in reader links`

### Task 3: Reader pages refuse a blob that does not match the link

**Files:**
- Modify: `pwa/src/hooks/useTab.ts`, `pwa/src/pages/Participant.tsx`, `pwa/src/pages/Group.tsx`, `pwa/src/components/ParticipantList.tsx`
- Test: `pwa/test/pages/Group.test.tsx`, `pwa/test/pages/Participant.test.tsx` (create if absent), `pwa/test/components/ParticipantList.test.tsx`, `pwa/test/pages/TabEntry.test.tsx`, `pwa/e2e/create-pay-withdraw.spec.ts` (only if it builds links itself)

**Interfaces:**
- Consumes: `Session.commit` (Task 2), `blobCommit` (Task 1).
- Produces: `TabState.verified: boolean` — `true` for admin; for group/participant, `true` iff `blobCommit(openedBlob)` equals `session.commit` (all 16 bytes). Computed once per new blob alongside `openTyped` (cache with `opened`). `rowStatuses(blob, view, verified = true)`: when `verified` is false every row is `{ status: null, mismatch: true }`.

- [ ] **Step 1: Write failing tests**
  - `Group.test.tsx`: `group page with wrong commitment shows mismatch and no Pay` — blob re-sealed with only the group key and a changed address, view addresses set to the forged ones, session commit from the original blob: every row shows "Address mismatch, do not pay"; no element with the Pay/Open wallet role.
  - `Participant.test.tsx`: same for a participant page.
  - `ParticipantList.test.tsx`: `rowStatuses marks every row mismatch when unverified`.
  - `TabEntry.test.tsx`: `old-format link without commitment shows the incomplete-link screen`.
- [ ] **Step 2: Run** `pnpm --filter @ztab/pwa test` — FAIL.
- [ ] **Step 3: Implement** `verified` in `useTab`; `Participant.tsx` renders the existing mismatch alert when `!verified` (before the address comparison); `Group.tsx` passes `verified` into `ParticipantList` → `rowStatuses`.
- [ ] **Step 4: Run** `pnpm --filter @ztab/pwa test && pnpm --filter @ztab/pwa e2e` — PASS.
- [ ] **Step 5: Commit** `pwa: reject reader blobs that do not match the link commitment`

### Task 4: Neutral ZIP-321 message

**Files:**
- Modify: `pwa/src/pages/Participant.tsx:67`, `pwa/src/components/ParticipantList.tsx:118`
- Test: `pwa/test/components/ParticipantList.test.tsx`, `pwa/test/pages/Participant.test.tsx`

- [ ] **Step 1: Write failing tests** `pay link message is neutral`: the rendered `zcash:` href contains `message=ZTab%20share` and contains neither the tab title nor the participant name (participant page and group list).
- [ ] **Step 2: Run** `pnpm --filter @ztab/pwa test` — FAIL.
- [ ] **Step 3: Implement**: pass the constant `'ZTab share'` as `message` in both places (a shared `PAY_MESSAGE` constant in `pwa/src/domain/zip321.ts` is fine).
- [ ] **Step 4: Run** `pnpm --filter @ztab/pwa test` — PASS.
- [ ] **Step 5: Commit** `pwa: keep the tab title and names out of the payment request`

### Task 5: Watcher sweeps deep notes only, at most 50, and reports the rest

**Files:**
- Modify: `watcher/src/facts.rs`, `watcher/src/sweep.rs`
- Test: unit tests in `watcher/src/facts.rs` (`#[cfg(test)]`), `watcher/tests/sweep.rs` where an offline path exists

**Interfaces:**
- Produces (in `facts.rs`):
  - `pub const SWEEP_MAX_INPUTS: usize = 50;` `pub const ZIP317_MARGINAL_FEE: u64 = 5_000;`
  - `pub struct SweepPlan { pub inputs: usize, pub inputs_zat: u64, pub fee_zat: u64, pub output_zat: u64, pub remaining_zat: u64 }`
  - `pub fn plan_sweep(notes: &[UnspentNote], tip: u32, confirmations_sweep: u32) -> SweepPlan` — eligible = confirmations ≥ `confirmations_sweep.max(1)` and `value_zat > ZIP317_MARGINAL_FEE`; take the largest eligible notes, at most `SWEEP_MAX_INPUTS`; `fee_zat = ZIP317_MARGINAL_FEE * max(inputs, 2)`; if `inputs_zat <= fee_zat` the plan is empty (`inputs = 0`, `output_zat = fee_zat = 0`); `remaining_zat` = sum of all unspent notes minus `inputs_zat`.
  - `TabBalance` gains `pub sweepable_zat: u64` = `plan_sweep(..).output_zat`, filled in `tab_balance`, serialized in the tab facts JSON.
- Produces (in `sweep.rs`): `SweepSummary` gains `pub remaining_zat: u64` (unspent tab value not in this sweep, mempool excluded). The proposal spends exactly the notes `plan_sweep` would choose: use `MaxSpendMode::MaxSpendable` when the eligible deep notes number ≤ `SWEEP_MAX_INPUTS`; when more, build the proposal from the chosen notes only (the implementer picks the mechanism available in pinned `zcash_client_backend 0.25.0-pre.1`, e.g. a single-step `Proposal` from explicitly selected notes or excluding the rest via input locks — read the crate in `~/.cargo/registry`). The resulting PCZT must have every value-carrying output paying the recipient (no change output), as `pczt_ops.rs` requires. Update the `MaxSpendMode::Everything` comment and the `not_spendable` message ("nothing is deep enough to sweep yet").

- [ ] **Step 1: Write failing unit tests** in `facts.rs`: `plan_sweep_skips_young_notes` (one deep 1 ZEC + one 1-conf note: inputs 1, remaining = young value); `plan_sweep_ignores_dust` (deep notes of 5 000 zat only: empty plan); `plan_sweep_caps_inputs_at_50` (51 deep notes of 10 000 zat: inputs 50, fee 250 000 < 500 000, remaining 10 000); `plan_sweep_empty_when_fee_exceeds_value` (two deep 6 000-zat notes: empty); `balance_reports_sweepable`.
- [ ] **Step 2: Run** `(cd watcher && cargo test --lib facts)` — FAIL.
- [ ] **Step 3: Implement** `plan_sweep`, `sweepable_zat`, the proposal change and `remaining_zat` in the summary.
- [ ] **Step 4: Run** `(cd watcher && cargo test)` — PASS (existing sweep tests stay green; adjust only assertions on the changed conflict message).
- [ ] **Step 5: Commit** `watcher: sweep only deep notes, cap inputs, report what is left`

### Task 6: API pass-through, PWA gate and withdraw dialog

**Files:**
- Modify: `api/src/watcher/watcher.types.ts`, `api/src/tabs/tab-view.ts` (`pickBalance`), `pwa/src/api/types.ts`, `pwa/src/domain/withdraw-gate.ts`, `pwa/src/components/WithdrawDialog.tsx`, `pwa/e2e/harness/stub-server.ts` and `api/test/stub-watcher.ts` (add the new fields to stub responses)
- Test: `api/src/tabs/tab-view.spec.ts`, `pwa/test/domain/withdraw-gate.test.ts`, `pwa/test/components/WithdrawDialog.test.tsx`

**Interfaces:**
- Consumes: watcher `balance.sweepable_zat`, `summary.remaining_zat` (Task 5).
- Produces: `Balance.sweepable_zat?: number` and `SweepOffer.summary.remaining_zat?: number` in both API and PWA types (optional: absent from older watchers). `withdrawGate`: `ready` iff `balance.sweepable_zat > 0` when the field is present; when absent, keep today's rule. Otherwise `wait` (minutes from `min_unspent_confirmations` as today) if `spendable_zat + pending_zat > 0`, else `nothing`.
- WithdrawDialog copy (exact): when `remaining_zat + pending_mempool_zat > 0`, a line `{amount} ZEC is still confirming; you can withdraw it later.` with `{amount}` formatted like the dialog's other ZEC amounts.

- [ ] **Step 1: Write failing tests**
  - `tab-view.spec.ts`: `balance passes sweepable_zat through for admin and group, never participant`.
  - `withdraw-gate.test.ts`: `ready with young notes when sweepable is positive`; `gate waits when sweepable is zero but spendable is not`; `falls back to the old rule without sweepable_zat`; `ready again on a closed tab with new deep notes` (`tabState 'closed'`, `sweepable_zat > 0`). Replace tests that assert the all-or-nothing rule when `sweepable_zat` is present.
  - `WithdrawDialog.test.tsx`: `shows the still-confirming line when the sweep leaves funds`; `no line when nothing is left`.
- [ ] **Step 2: Run** `pnpm --filter @ztab/api test && pnpm --filter @ztab/pwa test` — FAIL.
- [ ] **Step 3: Implement** types, `pickBalance`, gate, dialog line, stub fields.
- [ ] **Step 4: Run** `pnpm --filter @ztab/api test && pnpm --filter @ztab/pwa test && pnpm --filter @ztab/pwa e2e` — PASS.
- [ ] **Step 5: Commit** `api, pwa: withdraw what is deep enough and show what is left`

### Task 7: Cheap hardening (spec §3.5)

**Files:**
- Modify: `api/src/lifecycle/lifecycle.service.ts`, `api/src/tabs/tabs.service.ts`, `api/src/limits/limits.ts` (+ `limits.module.ts` / `config/config.ts` for the env), `api/src/setup.ts`, `deploy/Caddyfile`, `deploy/docker-compose.yml` (only if the env must be listed), `watcher/Dockerfile`
- Test: `api/src/lifecycle/lifecycle.service.spec.ts` (create if absent), `api/src/tabs/tabs.service.spec.ts` (or the existing create tests), `api/src/limits/*.spec.ts`, `api/src/setup` / e2e header test where headers are already asserted, `deploy/smoke/stack.spec.ts` (header assertions)

**Interfaces:**
- Consumes: existing `WatcherClient.setActive(tabId: string, active: boolean)`.
- Produces: env `RATE_LIMIT_CREATE_GLOBAL_PER_HOUR` (default `500`); over-limit returns the same 429 error body as the per-IP create limit.

- [ ] **Step 1: Write failing tests**
  - `purge pauses the tab at the watcher before deleting it`; `purge keeps the tab when the watcher is unreachable`; `purge treats watcher 404 as paused`.
  - `create pauses the watcher tab when the DB insert fails` (mock Prisma P2002 after `registerTab` succeeds: `setActive(id,false)` called once, response still 409); `create pauses the watcher tab after a watcher timeout` (503 path; `setActive` errors are swallowed).
  - `global create limit returns 429 after N creates from different IPs` (N from env in test).
  - `api responses carry Cache-Control no-store`.
  - `deploy/smoke/stack.spec.ts`: PWA response has `Cross-Origin-Opener-Policy: same-origin`; `/api/healthz` has `Cache-Control: no-store`.
- [ ] **Step 2: Run** `pnpm --filter @ztab/api test` — FAIL.
- [ ] **Step 3: Implement** the purge call, create compensation (best-effort, never masks the original error), global limit, `no-store` middleware in `setup.ts`, Caddy `Cross-Origin-Opener-Policy same-origin` in the PWA header block, and `cargo install cargo-chef --locked --version <current stable from crates.io>` in `watcher/Dockerfile`.
- [ ] **Step 4: Run** `pnpm --filter @ztab/api test && pnpm --filter @ztab/api typecheck && pnpm --filter @ztab/pwa e2e` — PASS. (The Caddy/smoke assertions run in CI's rehearsal job; locally run `bash deploy/rehearsal.sh` only if Docker images build offline.)
- [ ] **Step 5: Commit** `api, deploy: pause watcher tabs on purge and failed create, global create cap, COOP and no-store`

### Task 8: README privacy model and project invariants

**Files:**
- Modify: `README.md` (§ How it works, § Privacy model, § Status and limits), `.claude/skills/ztab-zcash-stack/reference/privacy-invariants.md` (items 6 and 9 where untrue)

Content is spec §3.4, in English, one bullet or table cell per item: withdraw address (server learns at withdraw, OVK-recoverable), public lightwalletd sees tab-payment txids (mainnet: own lightwalletd or Tor), individual-mode client/IP ↔ slot linkage, 30-day deletion is API-DB only (watcher retains), reader links carry a blob commitment so the server cannot swap addresses, tokens "stored only as SHA-256 hashes", modified JS from a compromised server, neutral ZIP-321 message. Remove "withdraw address" from "server never learns" and from the "sealed with AES-256-GCM" sentence's implication; make the e2e-test sentence claim only what `pwa/e2e/privacy.spec.ts` asserts. Also update "Try it" step 5 if it says withdraw needs every payment at 10 confirmations.

- [ ] **Step 1: Edit** README and invariants.
- [ ] **Step 2: Check** every claim against code: `grep -n "never learns\|withdraw address\|in clear\|10 confirmations\|deleted" README.md` — each remaining hit is true after Tasks 1–7 (purge now pauses the watcher tab but keeps its data).
- [ ] **Step 3: Commit** `docs: privacy model states exactly what the server learns`

### Task 9: Full verification and PR

- [ ] **Step 1: Run** the Global Constraints pre-push command — all PASS.
- [ ] **Step 2: Commit** the spec and this plan (`docs: security fixes spec and plan`) if not committed yet.
- [ ] **Step 3: Push** `git push -u origin security/audit-fixes` and `gh pr create` (title `Security fixes from audit run-1`; body: the four changes, test evidence, "old links stop working, create new tabs after deploy", attribution footer).
