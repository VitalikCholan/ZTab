# ZTab PWA restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every existing PWA screen into the dark "charcoal glass + Zcash yellow" look (mockup B) without changing behaviour, copy, requests or privacy.

**Architecture:** Design tokens and a handful of shared utilities (`btn-primary`, `btn-secondary`, `card`, `field`, `pill`) live in `pwa/src/index.css`; components swap their Tailwind classes to those. Two small additions: a `PoweredByZcash` link component and a progress bar inside `ParticipantList`. New dark PWA icon.

**Tech Stack:** React 19, Tailwind CSS 4 (`@theme`, `@utility`), Vite 8, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-ztab-pwa-restyle-design.md` (Ukrainian). Read it before starting.

## Global Constraints

- Shell prefix: `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$HOME/Library/pnpm:$PATH"`. Never print or reference `~/.config/ztab/*`.
- Branch `pwa/restyle` from `main`; never push to `main`, never force-push. Commit trailers from the session attribution reminder.
- No `style=` prop, no inline `<style>`/`<script>`: CSP is `style-src 'self'`, `img-src 'self' data:`.
- No new npm dependencies, no third-party fonts/CDN/hosts.
- Do not change copy, `aria-*` names, roles, routes, element order, API calls, storage, crypto.
- Existing tests stay unchanged except exactly two: `test/components/WithdrawDialog.test.tsx:83` (`text-red-700` → `text-danger`) and `test/pages/Landing.test.tsx:28` (2 links → 3).
- Token values (spec §3.1): `bg #0d0f14`, `glow #2a2210`, `surface rgb(255 255 255 / 0.04)`, `line rgb(255 255 255 / 0.08)`, `fg #e8e6e1`, `muted ≈#9a978f` (AA on `bg`), `accent #F4B728`, `accent-deep #e9a812`, `on-accent #1a1300`; `ok`/`danger`/`info` light green/red/blue (Tailwind `-300/-400` level).
- Body background `radial-gradient(120% 60% at 50% 0%, glow 0%, bg 55%)`, `color-scheme: dark`. App is always dark.
- Zcash mark: never larger/more prominent than the ZTab wordmark; always wrapped in `<a href="https://z.cash/" target="_blank" rel="noopener noreferrer">`.
- QR always on white.
- Text contrast WCAG AA (4.5:1).
- Before every push: `pnpm --filter @ztab/pwa typecheck && pnpm --filter @ztab/pwa test && pnpm --filter @ztab/pwa e2e && pnpm --filter @ztab/pwa build`.

## Review Focus

1. Long unbroken strings (unified addresses, admin URL, 40-char names) inside the new padded cards on a 375 px wide phone must wrap, never cause horizontal scroll. Pinned in Task 7 (screenshot at 375×812 plus `scrollWidth <= clientWidth` check).
2. Users with reduced-motion settings must not see the pulsing "seen" dot. Pinned in Task 2 (`motion-safe:` class assertion).
3. Overpaid tabs (collected > total) and odd totals must not draw the progress bar past 100 % or report `aria-valuenow` > max. Pinned in Task 4.
4. A disabled primary button (withdraw gate not ready, form invalid) must still look clearly disabled on dark, and keyboard focus must be visible. Pinned in Task 1 (utility definitions include `disabled:` and `focus-visible:` states) and checked in Task 7 screenshots.
5. iPhone Safari (the main demo device) must render the glass cards and glow; `backdrop-filter` needs its `-webkit-` prefix. Pinned in Task 1 (check built CSS contains `-webkit-backdrop-filter`) and Task 7 (post-deploy iPhone check).

---

### Task 1: Theme tokens, shared utilities, theme colour

**Files:**
- Modify: `pwa/src/index.css`
- Modify: `pwa/index.html` (`<meta name="theme-color">`)
- Modify: `pwa/vite.config.ts` (`theme_color`, `background_color`)
- Add to git: `docs/superpowers/specs/2026-10-25-ztab-pwa-restyle-design.md`, this plan

**Interfaces:**
- Produces Tailwind colour utilities from `@theme` `--color-*`: `bg-bg`, `text-fg`, `text-muted`, `bg-surface`, `border-line`, `text-accent`, `bg-accent`, `text-on-accent`, `text-ok`, `text-danger`, `text-info` (and their `bg-*/border-*` forms).
- Produces `@utility` classes: `btn-primary`, `btn-secondary`, `card`, `field`, `pill`. `pill` sets shape only; tone comes from extra classes added by `StatusBadge`.

- [ ] **Step 1:** `git checkout -b pwa/restyle`; commit the spec and plan (`docs: pwa restyle design and plan`).
- [ ] **Step 2:** In `index.css` add `--color-*` tokens to `@theme` with the Global Constraints values; base layer: `html { color-scheme: dark }`, `body` gets `bg`, `fg` and the radial gradient (min-height full viewport so the gradient does not tile).
- [ ] **Step 3:** Add `@utility` definitions per spec §3.2. `btn-primary`: gradient `accent → accent-deep`, `on-accent` text, bold, `rounded-xl`, yellow glow shadow, `focus-visible` ring `accent`, `disabled` = no glow + `opacity-40` + `cursor-not-allowed`. `btn-secondary`: transparent, `border-line`, `fg`, hover lighter border, same focus ring and disabled state. `card`: `bg-surface`, `border-line`, `rounded-2xl`, `backdrop-blur`. `field`: `bg-surface`, `border-line`, `rounded-xl`, `fg`, placeholder `muted`, focus border/ring `accent`, `aria-[invalid=true]` border `danger`. `pill`: inline-flex, gap, `rounded-full`, small semibold, border.
- [ ] **Step 4:** `theme-color` meta and manifest `theme_color`/`background_color` → `#0d0f14`.
- [ ] **Step 5:** Run build; Expected: success. Run `grep -c -- '-webkit-backdrop-filter' pwa/dist/assets/*.css` → ≥1 (add an explicit fallback in the utility if 0). Run `grep -rn 'style=' pwa/src` → no hits.
- [ ] **Step 6:** Run `test` and `typecheck` → PASS (nothing uses the classes yet).
- [ ] **Step 7:** Commit `pwa: dark theme tokens and shared utilities`.

### Task 2: Small shared components

**Files:**
- Modify: `pwa/src/components/StatusBadge.tsx`, `Toast.tsx`, `StaleBanner.tsx`, `ErrorScreen.tsx`, `CopyButton.tsx`, `ShareButton.tsx`, `Amount.tsx`, `BalanceCard.tsx`, `QrCode.tsx`
- Create: `pwa/test/components/StatusBadge.test.tsx`

**Interfaces:**
- Consumes: Task 1 utilities and tokens.
- Produces: unchanged component props. `CopyButton` gains optional `variant?: 'primary' | 'secondary'` (default `'primary'`, today's filled look); `ShareButton` gains the same prop (default `'secondary'`).

- [ ] **Step 1: Write failing tests** in `StatusBadge.test.tsx`:
  - `renders the existing label for every badge` — for each key of `BADGE_LABEL`, text equals the label.
  - `seen pulses only when motion is allowed` — the dot element inside the `seen` badge has class `motion-safe:animate-pulse`; the `paid` badge's dot does not.
  - `paid uses the ok tone, waiting the accent tone` — badge element has `text-ok` / `text-accent`.
- [ ] **Step 2:** Run `pnpm --filter @ztab/pwa test StatusBadge` → FAIL.
- [ ] **Step 3:** Restyle. `StatusBadge`: `pill` + tone classes + an `aria-hidden` dot span (glow `shadow` on accent dot); tones per spec §3.3 (`waiting`/`partial` accent, `seen` accent + pulse, paid-family `ok`, `unknown` `muted`). `Toast`: `text-ok`/`text-danger`. `StaleBanner`: accent-tinted `card`-like box. `ErrorScreen`: `fg` title, `muted` body. Copy/Share: `btn-primary`/`btn-secondary` by `variant`. `Amount`: USD large bold `fg`, ZEC `muted font-mono`. `BalanceCard`: `card`. `QrCode` canvas: white, `rounded-2xl`, padding via a white wrapper, soft yellow glow shadow.
- [ ] **Step 4:** Run `test` → all PASS (new and existing).
- [ ] **Step 5:** Commit `pwa: restyle shared components for the dark theme`.

### Task 3: Powered by Zcash

**Files:**
- Create: `pwa/public/zcash-mark.svg` (official `Brandmark-Yellow.svg` from https://z.cash/press/, `style="fill: #f4b728; fill-rule: evenodd;"` replaced by `fill="#f4b728" fill-rule="evenodd"` attributes)
- Create: `pwa/src/components/PoweredByZcash.tsx`
- Create: `pwa/test/components/PoweredByZcash.test.tsx`
- Modify: `pwa/src/pages/Landing.tsx`, `Participant.tsx`, `Group.tsx`, `Admin.tsx` (placement only)
- Modify: `pwa/test/pages/Landing.test.tsx:28` (expect 3 links)

**Interfaces:**
- Produces: `export function PoweredByZcash(): JSX.Element` (no props).

- [ ] **Step 1: Write failing test** `PoweredByZcash.test.tsx`:
  - link with accessible name `Powered by Zcash` has `href` `https://z.cash/`, `target` `_blank`, `rel` `noopener noreferrer`;
  - contains an `img` with `src` `/zcash-mark.svg` and empty `alt` (decorative; the text names it), `width`/`height` 16.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Download the SVG (`curl -sfL https://z.cash/wp-content/uploads/2023/11/Brandmark-Yellow.svg`), swap the `style` attribute for `fill`/`fill-rule`, save to `public/`. Implement the component: small `muted` text, mark 16 px, wordmark ZTab elsewhere stays larger.
- [ ] **Step 4:** Place it: Landing below the testnet wallet line (or below the CTA on mainnet); Participant, Group, Admin directly after the existing "Payments are shielded…" footer. Not on NewTab/Links.
- [ ] **Step 5:** Update `Landing.test.tsx:28` to expect 3 links (add `Powered by Zcash` to the expected names). Run `test` → PASS.
- [ ] **Step 6:** Commit `pwa: Powered by Zcash link`.

### Task 4: Progress bar in ParticipantList

**Files:**
- Modify: `pwa/src/components/ParticipantList.tsx`
- Modify/extend: `pwa/test/pages/Group.test.tsx` (or a new `test/components/ParticipantList.test.tsx` using `test/helpers/fixtures.ts`)

**Interfaces:**
- Consumes: existing `collectedCents`, `blob.total_cents` computed in `ParticipantList`.
- Produces: an element with `role="progressbar"`, `aria-label="Collected"`, `aria-valuemin=0`, `aria-valuemax={total_cents}`, `aria-valuenow={min(collectedCents, total_cents)}`.

- [ ] **Step 1: Write failing tests:**
  - `progress bar reports collected of total` — half paid fixture → `aria-valuenow` equals collected cents, `aria-valuemax` equals `total_cents`.
  - `progress bar clamps when overpaid` — overpaid fixture → `aria-valuenow` equals `total_cents`.
  - `progress bar is empty when nothing is paid` → `aria-valuenow` `0`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Render the bar under the existing "$X of $Y collected · N of M paid" line (line text unchanged). Width without `style=`: quantise to 5 % steps and map to a static class list (e.g. `w-[0%]`…`w-[100%]` written out literally so Tailwind generates them), or use a `<progress>`/`<meter>` styled via CSS pseudo-elements. Fill: accent gradient; track: `bg-surface`. Guard `total_cents === 0` → 0 %.
- [ ] **Step 4:** Run `test` → PASS.
- [ ] **Step 5:** Commit `pwa: collected progress bar`.

### Task 5: Create flow screens

**Files:**
- Modify: `pwa/src/pages/NewTab.tsx`, `pwa/src/pages/Links.tsx`, `pwa/src/components/ParticipantsEditor.tsx`, `RateField.tsx`, `AddressField.tsx`

**Interfaces:**
- Consumes: Task 1 utilities; Task 2 `CopyButton`/`ShareButton` `variant`.

- [ ] **Step 1:** NewTab: inputs → `field`; rate, participants, mode groups → `card`; mode options as selectable cards (selected = `border-accent`, use `has-[:checked]:` variant, keep the real radio inputs and labels); "Create tab" → `btn-primary w-full`; error blocks → `text-danger` with `danger`-tinted border; Retry/Cancel → `btn-secondary`.
- [ ] **Step 2:** ParticipantsEditor/RateField/AddressField: `field`, `btn-secondary`, hints `muted`, errors `danger`; long names/addresses keep `break-words`/`break-all`.
- [ ] **Step 3:** Links: warning `text-danger` bold; admin URL input `field font-mono`; Copy `variant="primary"`, Share `variant="secondary"`; Continue/Open admin page `btn-primary`; participant rows `card`.
- [ ] **Step 4:** Run `test` → PASS (no test edits).
- [ ] **Step 5:** Commit `pwa: restyle create flow`.

### Task 6: Tab screens and withdraw dialog

**Files:**
- Modify: `pwa/src/pages/Landing.tsx`, `Admin.tsx`, `Group.tsx`, `Participant.tsx`, `pwa/src/components/ParticipantList.tsx`, `PayPanel.tsx`, `WithdrawDialog.tsx`
- Modify: `pwa/test/components/WithdrawDialog.test.tsx:83` (`text-red-700` → `text-danger`)

- [ ] **Step 1:** Update the WithdrawDialog test assertion to `toHaveClass('text-danger')`; run → FAIL.
- [ ] **Step 2:** WithdrawDialog: overlay `bg-black/60 backdrop-blur-sm`; sheet dark (slightly lighter than `bg`, `border-line`, `rounded-t-2xl sm:rounded-2xl`); Confirm `btn-primary`, Cancel/Back `btn-secondary`, Done `btn-primary`; "(not your address)", mismatch and error text `text-danger`; withdrawn text `text-ok`; explorer link `text-accent underline`.
- [ ] **Step 3:** Landing: wordmark large bold `fg`; network badge → `pill` with accent dot; CTA `btn-primary`; faucet link `text-accent`.
- [ ] **Step 4:** Admin/Group/Participant: titles `fg`, "Hi, …" `muted`, footers `muted`; Admin withdraw button `btn-primary w-full`; admin-link section separated by `border-line`, warning `text-danger`, input `field`. Participant mismatch alert → `danger`-tinted box. ParticipantList rows → `card`, Pay → `btn-secondary`, mismatch label `danger`.
- [ ] **Step 5:** PayPanel: phone "Pay with your wallet" → `btn-primary w-full` (keep it an `<a>`); `<details>` summary `muted`; address `font-mono break-all`; copy buttons `variant="secondary"`.
- [ ] **Step 6:** Run `typecheck`, `test` → PASS.
- [ ] **Step 7:** Commit `pwa: restyle tab screens and withdraw dialog`.

### Task 7: PWA icon, full verification, screenshots, PR

**Files:**
- Modify: `pwa/public/icon.svg`, `pwa/public/icon-192.png`, `pwa/public/icon-512.png`
- Create (scratchpad only, not committed): a Playwright screenshot script

- [ ] **Step 1:** New `icon.svg`: `#0d0f14` background with a soft yellow radial glow, the existing ZTab Z path in `#e8e6e1`, one yellow `#F4B728` accent (bar or dot). Not a yellow Z in a circle. Content inside the central 80 % (maskable).
- [ ] **Step 2:** Render PNGs 192/512 with Playwright Chromium (load the SVG, `page.screenshot` at exact size). Check with `sips -g pixelWidth -g pixelHeight`.
- [ ] **Step 3:** Run the full gate: `typecheck`, `test`, `e2e`, `build` → all PASS. `grep -rn 'style=' pwa/src` → none. `dist/index.html` has no inline script/style.
- [ ] **Step 4:** Screenshot script against the e2e harness (reuse `e2e/harness` start and `flow.ts` helpers) at 375×812: Landing, NewTab (filled, mode selected), Links (revealed), Admin (one participant paid → bar partly filled), Group, Participant in waiting/seen/paid, WithdrawDialog confirm, ErrorScreen (Incomplete). On each page assert `document.documentElement.scrollWidth <= clientWidth` (Review Focus 1). Save PNGs to the scratchpad.
- [ ] **Step 5:** Show screenshots to Vitalii; apply feedback (new commit per round).
- [ ] **Step 6:** Commit `pwa: dark app icon`; push `pwa/restyle`; `gh pr create` (English title/body: what changed, no behaviour change, screenshots summary, two test edits explained; PR trailer from attribution reminder). Owner merges.
- [ ] **Step 7 (after merge + deploy, owner runs update.sh or says "так"):** open https://ztab.dev on iPhone Safari: glass cards and glow render, home-screen icon is new (Review Focus 5).
