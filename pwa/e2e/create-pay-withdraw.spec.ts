// End-to-end against the real API (built from api/) and the stub watcher (e2e/harness).
import { readFileSync } from 'node:fs';
import { devices, expect, test, type Page } from '@playwright/test';
import { centsToZat, zatToZecString } from '../src/domain/money.ts';
import { createViaForm, openAdminPage, recordCopies, USD_PER_ZEC } from './harness/flow.ts';
import { stub } from './harness/stub.ts';

const FIXTURES = new URL('../../crypto/rust/tests/fixtures/tab/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')) as {
  outputZat: number;
  feeZat: number;
  totalInZat: number;
  txid: string;
  addresses: string[];
};
const PCZT_B64 = readFileSync(new URL('sweep.proved.pczt', FIXTURES)).toString('base64');

/** $25.00 at the stub's 400.5 USD/ZEC. */
const SHARE_ZAT = centsToZat(2500, USD_PER_ZEC);
/** The admin page polls every 10 s. */
const POLL = { timeout: 15_000 };

test.beforeEach(async ({ page }) => {
  await stub.reset();
  await recordCopies(page);
});

const row = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });

test.describe('desktop', { tag: '@desktop' }, () => {
  test('(a) group tab: waiting, payment seen, paid', async ({ page }) => {
    const { tabId } = await createViaForm(page, { title: 'Dinner', total: '50.00', names: ['Alice', 'Bob'], mode: 'Group' });
    await openAdminPage(page, tabId);

    await expect(page.getByRole('heading', { name: 'Dinner' })).toBeVisible();
    await expect(row(page, 'Alice').getByText('Waiting for payment')).toBeVisible();
    await expect(row(page, 'Bob').getByText('Waiting for payment')).toBeVisible();
    await expect(page.getByText('Waiting for payment')).toHaveCount(2);

    const payment = {
      txid: 'bb'.repeat(32),
      value_zat: SHARE_ZAT,
      mined_height: null,
      confirmations: 0,
      transparent_source: false,
      first_seen_at: new Date().toISOString(),
    };
    await stub.patchParticipant(tabId, 1, {
      payments: [payment],
      status_facts: { confirmed_zat: 0, mempool_zat: SHARE_ZAT, best_confirmations: 0, transparent_source: false },
    });
    await expect(row(page, 'Bob').getByText('Payment seen, confirming…')).toBeVisible(POLL);
    await expect(row(page, 'Alice').getByText('Waiting for payment')).toBeVisible();

    await stub.patchParticipant(tabId, 1, {
      payments: [{ ...payment, mined_height: 101, confirmations: 3 }],
      status_facts: { confirmed_zat: SHARE_ZAT, mempool_zat: 0, best_confirmations: 3, transparent_source: false },
    });
    await expect(row(page, 'Bob').getByText('Paid', { exact: true })).toBeVisible(POLL);
    await expect(page.getByText('$25.00 of $50.00 collected · 1 of 2 paid')).toBeVisible();
    await expect(row(page, 'Alice').getByText('Waiting for payment')).toBeVisible();
  });

  /** Creates a tab whose watcher offers the fixture sweep, then opens the withdraw dialog. */
  async function openWithdraw(
    page: Page,
    outputZat: number,
    opts: { address?: string; line?: string } = {},
  ) {
    const { tabId } = await createViaForm(page, {
      title: 'Dinner',
      total: '50.00',
      names: ['Alice', 'Bob'],
      mode: 'Group',
      address: opts.address,
    });
    await stub.patchTab(tabId, {
      balance: { spendable_zat: expected.outputZat, pending_zat: 0, swept_zat: 0, min_unspent_confirmations: 12 },
    });
    await stub.setSweepResult(tabId, {
      pczt_b64: PCZT_B64,
      summary: {
        inputs_zat: expected.totalInZat,
        output_zat: outputZat,
        fee_zat: expected.feeZat,
        expiry_height: 220,
        txid: expected.txid,
      },
    });
    await openAdminPage(page, tabId);
    await page.getByRole('button', { name: 'Withdraw to my wallet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Withdraw to my wallet' });
    await expect(dialog.getByText(opts.line ?? 'Send 0.0199 ZEC to utest1ar2v…gwc4d (your address) · fee 0.0001 ZEC')).toBeVisible();
    expect(await stub.callsTo('sweep')).toHaveLength(1);
    return dialog;
  }

  test('(c) withdraw: a PCZT for another key fails signing with pczt_mismatch, nothing broadcast', async ({ page }) => {
    const dialog = await openWithdraw(page, expected.outputZat);
    await expect(dialog.getByText('Server says: 0.0199 ZEC')).toBeVisible();
    await expect(dialog.getByText('The server proposed a different payment. Nothing was signed.')).toHaveCount(0);
    const confirm = dialog.getByRole('button', { name: 'Confirm' });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog.getByRole('alert')).toHaveText('Signing failed: pczt_mismatch');
    expect(await stub.callsTo('broadcast')).toEqual([]);
  });

  test('tampered summary blocks confirm', async ({ page }) => {
    const dialog = await openWithdraw(page, expected.outputZat + 1);
    await expect(dialog.getByText(`Server says: ${zatToZecString(expected.outputZat + 1)} ZEC`)).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveText('The server proposed a different payment. Nothing was signed.');
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(await stub.callsTo('broadcast')).toEqual([]);
  });

  test('a PCZT paying another address: the screen shows that address as not yours, Confirm disabled', async ({ page }) => {
    // A valid testnet UA (the fixture tab's own address 0) that is not the fixture PCZT's output.
    const dialog = await openWithdraw(page, expected.outputZat, {
      address: expected.addresses[0],
      line: 'Send 0.0199 ZEC to utest1ar2v…gwc4d (not your address) · fee 0.0001 ZEC',
    });
    await expect(dialog.getByText('(your address)', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveText('The server proposed a different payment. Nothing was signed.');
    const confirm = dialog.getByRole('button', { name: 'Confirm' });
    await expect(confirm).toBeDisabled();
    await confirm.click({ force: true });
    expect(await stub.callsTo('broadcast')).toEqual([]);
  });
});

test.describe('phone', { tag: '@phone' }, () => {
  test('(b) individual tab: a participant link shows only that participant', async ({ page, browser }) => {
    const { tabId, links } = await createViaForm(page, {
      title: 'Dinner',
      total: '50.00',
      names: ['Alice', 'Bob'],
      mode: 'Individual',
    });
    expect(links).toHaveLength(2);
    const bobLink = links[1];
    expect(new URL(bobLink).hash).toMatch(/^#p=1\./);
    const [alice, bob] = (await stub.getTab(tabId)).participants;

    // A fresh browser, as if Bob opened the link from a message.
    const context = await browser.newContext({ ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:4173' });
    try {
      const bobPage = await context.newPage();
      await bobPage.goto(bobLink);
      await expect(bobPage.getByText('Hi, Bob')).toBeVisible({ timeout: 10_000 });
      await expect(bobPage).toHaveURL(`/t/${tabId}`);
      expect(bobPage.url()).not.toContain('#');
      await expect(bobPage.getByText(`$25.00 ≈ ${zatToZecString(SHARE_ZAT)} ZEC`)).toBeVisible();
      await expect(bobPage.getByText('Waiting for payment')).toBeVisible();

      const pay = bobPage.getByRole('link', { name: 'Pay with your wallet' });
      const href = (await pay.getAttribute('href')) ?? '';
      expect(href.startsWith(`zcash:${bob.address}?`)).toBe(true);
      expect(href).toContain(`amount=${zatToZecString(SHARE_ZAT)}`);

      const html = await bobPage.content();
      const text = await bobPage.locator('body').innerText();
      for (const raw of [html, text]) {
        expect(raw).not.toContain('Alice');
        expect(raw).not.toContain(alice.address);
      }
    } finally {
      await context.close();
    }
  });
});
