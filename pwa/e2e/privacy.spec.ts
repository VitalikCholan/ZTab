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

/**
 * How long, once the flow is done, a request's full (raw) headers may still take to arrive.
 * `Request.allHeaders()` waits, with no timeout, for Chromium's raw-headers event, and settles
 * early only if the page or service worker closes. Some requests never get that event: a fetch
 * the `/` page starts just before the test navigates to /new (no response, finished or failed
 * event ever follows), or the service worker's own `/sw.js` script fetch (finished, raw headers
 * never paired). Their pages stay open, so awaiting `allHeaders()` hung the test until its
 * 30 s timeout. Every request settles in milliseconds here; the bound only cuts off those.
 */
const FULL_HEADERS_GRACE_MS = 2_000;

test.describe('privacy', { tag: '@desktop' }, () => {
  test.beforeEach(() => stub.reset());

  for (const mode of ['Group', 'Individual'] as const) {
    test(`${mode.toLowerCase()} tab: secrets stay in the browser`, async ({ page, context }) => {
      await recordCopies(page);
      // Everything but the full headers is captured synchronously, so no request can escape the
      // checks below. Headers are the request's provisional ones (every header the page itself
      // set, plus the browser's), upgraded to the full raw set when Chromium delivers it; the raw
      // set adds only network-layer headers (Host, Connection, Accept-Encoding, Cookie). The one
      // of those a page could put data into, Cookie, is covered by the no-cookies check below.
      const pending: { recorded: Recorded; full: Promise<Record<string, string> | null> }[] = [];
      context.on('request', (r: Request) =>
        pending.push({
          recorded: { method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() ?? '' },
          // Rejects when the request's page has closed (the link page); the provisional set stands.
          full: r.allHeaders().then(
            (h) => h,
            () => null,
          ),
        }),
      );

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
      const { tabId, adminUrl, links } = await test.step('create the tab', async () => {
        await page.goto('/');
        await checkPage(page);
        const created = await createViaForm(page, { title: 'Dinner', total: '50.00', names, mode });
        await checkPage(page);
        return created;
      });

      await test.step('open the shared link', async () => {
        // Opened by its recipient (a second tab in the same browser).
        const linkPage = await context.newPage();
        await linkPage.goto(links[mode === 'Group' ? 0 : 1]);
        await expect(linkPage.getByRole('heading', { name: 'Dinner' })).toBeVisible({ timeout: 10_000 });
        await expect(linkPage).toHaveURL(`/t/${tabId}`);
        await checkPage(linkPage);
        await linkPage.close();
      });

      await test.step('open the admin page', async () => {
        // From the links screen (in-memory session) and from the saved admin link.
        await openAdminPage(page, tabId);
        await expect(page.getByRole('button', { name: /Nothing to withdraw yet|Withdraw/ })).toBeVisible({ timeout: 10_000 });
        await checkPage(page);
        const adminPage = await context.newPage();
        await adminPage.goto(adminUrl);
        await expect(adminPage.getByRole('heading', { name: 'Dinner' })).toBeVisible({ timeout: 10_000 });
        await expect(adminPage).toHaveURL(`/t/${tabId}`);
        await checkPage(adminPage);
      });

      expect(titles.every((t) => t === 'ZTab')).toBe(true);

      const requests = await test.step('collect request headers', async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<null>((done) => (timer = setTimeout(() => done(null), FULL_HEADERS_GRACE_MS)));
        const settled = await Promise.all(
          pending.map(async ({ recorded, full }) => {
            const headers = await Promise.race([full, grace]);
            if (headers) return { ...recorded, headers };
            test.info().annotations.push({ type: 'provisional headers only', description: `${recorded.method} ${recorded.url}` });
            return recorded;
          }),
        );
        clearTimeout(timer);
        return settled;
      });
      // No cookie (set by script or by a response) could have carried anything in a Cookie header.
      expect(await context.cookies()).toEqual([]);
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
