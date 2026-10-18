// Shared browser steps: the create form, the links screen and a clipboard/share recorder.
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/** Recipient of the withdraw fixture, used as every tab's withdrawal address. */
export const FIXTURE_RECIPIENT = (
  JSON.parse(readFileSync(new URL('../../../crypto/rust/tests/fixtures/tab/expected.json', import.meta.url), 'utf8')) as {
    recipient: string;
  }
).recipient;
/** What the stub's rate upstream answers (stub-server.ts). */
export const USD_PER_ZEC = 400.5;

/**
 * Replaces the clipboard and the share sheet with recorders: every copied or shared text lands
 * in `window.__copied`, so a test can read the links the way a user would receive them.
 */
export async function recordCopies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void w.__copied.push(t) },
    });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: ShareData) => void w.__copied.push(d.text ?? d.url ?? ''),
    });
  });
}

export const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** The last URL in a copied or shared text. */
export function urlIn(text: string): string {
  const all = text.match(/https?:\/\/\S+/g);
  if (!all) throw new Error(`no URL in ${JSON.stringify(text)}`);
  return all[all.length - 1];
}

export interface CreatedViaForm {
  tabId: string;
  adminUrl: string;
  /** Group mode: the one group link; individual: one link per participant, in order. */
  links: string[];
}

/**
 * Fills /new (total split equally), creates the tab, copies the admin link, continues, and
 * shares every participant link. Leaves the page on the links screen with "Open admin page".
 */
export async function createViaForm(
  page: Page,
  opts: { title: string; total: string; names: string[]; mode: 'Group' | 'Individual'; address?: string },
): Promise<CreatedViaForm> {
  await page.goto('/new');
  await expect(page.getByText(`1 ZEC = $${USD_PER_ZEC}`)).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Tab name').fill(opts.title);
  await page.getByLabel('Total, USD').fill(opts.total);
  for (let i = 0; i < opts.names.length; i++) {
    if (i > 0) await page.getByRole('button', { name: 'Add participant' }).click();
    await page.getByLabel(`Name ${i + 1}`).fill(opts.names[i]);
  }
  await page.getByRole('button', { name: 'Split equally' }).click();
  await page.getByRole('radio', { name: new RegExp(`^${opts.mode}\\b`) }).check();
  const address = page.getByLabel('Your Zcash address for withdrawal');
  await address.fill(opts.address ?? FIXTURE_RECIPIENT);
  await address.blur();
  const create = page.getByRole('button', { name: 'Create tab' });
  await expect(create).toBeEnabled({ timeout: 10_000 });
  await create.click();

  await expect(page.getByRole('heading', { name: 'Tab created' })).toBeVisible({ timeout: 15_000 });
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeDisabled();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await continueButton.click();

  const shareNames = opts.mode === 'Group' ? ['Everyone'] : opts.names;
  for (const name of shareNames) await page.getByRole('button', { name: `Share ${name}`, exact: true }).click();

  const texts = await copied(page);
  expect(texts).toHaveLength(1 + shareNames.length);
  const adminUrl = urlIn(texts[0]);
  const tabId = new URL(adminUrl).pathname.split('/')[2];
  expect(new URL(adminUrl).hash).toMatch(/^#a=/);
  return { tabId, adminUrl, links: texts.slice(1).map(urlIn) };
}

export async function openAdminPage(page: Page, tabId: string): Promise<void> {
  await page.getByRole('button', { name: 'Open admin page' }).click();
  await expect(page).toHaveURL(`/t/${tabId}`);
}
