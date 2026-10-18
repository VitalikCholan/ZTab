// No link secret ever leaves the browser: every request of the create → links → participant/
// group link → admin flow is recorded and searched for the fragments, their keys and the UFVK,
// and for the tab's plaintext (title, names, USD amounts), which lives only in the AES-GCM blobs.
import { expect, test, type Page, type Request } from '@playwright/test';
import { createViaForm, openAdminPage, recordCopies } from './harness/flow.ts';
import { stub } from './harness/stub.ts';

/** The tab's plaintext; none of it may appear in any request. */
const PLAINTEXT = ['Dinner', 'Alice', 'Bob', '25.00', '50.00'];

/**
 * `needle` as a whole token. Base64 ciphertext is a run of letters and digits, so a short needle
 * like "Bob" can occur inside it by chance; a real leak ("name":"Bob", ?q=Bob) is delimited.
 */
const asToken = (needle: string) => new RegExp(`(?<![A-Za-z0-9])${needle.replaceAll('.', '\\.')}(?![A-Za-z0-9])`);

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

test.describe('privacy', { tag: '@desktop' }, () => {
  test.beforeEach(() => stub.reset());

  for (const mode of ['Group', 'Individual'] as const) {
    test(`${mode.toLowerCase()} tab: secrets stay in the browser`, async ({ page, context }) => {
      await recordCopies(page);
      const pending: Promise<Recorded>[] = [];
      const record = async (r: Request): Promise<Recorded> => ({
        method: r.method(),
        url: r.url(),
        headers: await r.allHeaders().catch(() => r.headers()),
        body: r.postData() ?? '',
      });
      context.on('request', (r) => pending.push(record(r)));

      const titles: string[] = [];
      const checkPage = async (p: Page) => {
        titles.push(await p.title());
        expect(p.url()).not.toContain('#');
        const storage = await p.evaluate(() => ({
          local: Object.keys(localStorage),
          session: Object.keys(sessionStorage),
        }));
        for (const k of storage.local) expect(['ztab.adminWarningSeen']).toContain(k);
        expect(storage.session).toEqual([]);
      };

      const names = ['Alice', 'Bob'];
      await page.goto('/');
      await checkPage(page);
      const { tabId, adminUrl, links } = await createViaForm(page, { title: 'Dinner', total: '50.00', names, mode });
      await checkPage(page);

      // The shared link, opened by its recipient (a second tab in the same browser).
      const linkPage = await context.newPage();
      await linkPage.goto(links[mode === 'Group' ? 0 : 1]);
      await expect(linkPage.getByRole('heading', { name: 'Dinner' })).toBeVisible({ timeout: 10_000 });
      await expect(linkPage).toHaveURL(`/t/${tabId}`);
      await checkPage(linkPage);
      await linkPage.close();

      // The admin page, from the links screen (in-memory session) and from the saved admin link.
      await openAdminPage(page, tabId);
      await expect(page.getByRole('button', { name: /Nothing to withdraw yet|Withdraw/ })).toBeVisible({ timeout: 10_000 });
      await checkPage(page);
      const adminPage = await context.newPage();
      await adminPage.goto(adminUrl);
      await expect(adminPage.getByRole('heading', { name: 'Dinner' })).toBeVisible({ timeout: 10_000 });
      await expect(adminPage).toHaveURL(`/t/${tabId}`);
      await checkPage(adminPage);

      expect(titles.every((t) => t === 'ZTab')).toBe(true);

      const requests = await Promise.all(pending);
      const http = requests.filter((r) => /^https?:/.test(r.url));
      expect(http.length).toBeGreaterThan(0);
      expect(http.some((r) => r.method === 'PUT' && r.url === `http://127.0.0.1:3000/tabs/${tabId}`)).toBe(true);

      const fragments = [adminUrl, ...links].map((u) => new URL(u).hash);
      expect(fragments.every((f) => /^#[agp]=/.test(f))).toBe(true);
      // The 43-char base64url key of each fragment.
      const keys = fragments.map((f) => /([A-Za-z0-9_-]{43})$/.exec(f)?.[1]);
      expect(keys.every((k) => k !== undefined)).toBe(true);

      for (const r of http) {
        expect(['127.0.0.1', 'localhost']).toContain(new URL(r.url).hostname);
        let body = r.body;
        if (r.method === 'PUT' && r.url === `http://127.0.0.1:3000/tabs/${tabId}`) {
          // The UFVK is meant for the server (its watcher scans with it); nothing else may carry it.
          const parsed = JSON.parse(body) as { ufvk: string };
          expect(parsed.ufvk).toMatch(/^uviewtest1/);
          body = JSON.stringify({ ...parsed, ufvk: undefined });
        }
        const haystacks = [r.url, JSON.stringify(r.headers), body];
        for (const h of haystacks) {
          expect(h, `${r.method} ${r.url}`).not.toContain('#');
          expect(h, `${r.method} ${r.url}`).not.toContain('uviewtest');
          for (const k of keys) expect(h, `${r.method} ${r.url}`).not.toContain(k);
          for (const t of PLAINTEXT) expect(h, `${r.method} ${r.url}: ${t}`).not.toMatch(asToken(t));
        }
      }
    });
  }
});
