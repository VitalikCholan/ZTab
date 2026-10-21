import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('boots, loads wasm, talks only to localhost', async ({ page }) => {
  const hosts = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'http:' || u.protocol === 'https:') hosts.add(u.hostname);
  });
  await page.goto('/');
  await expect(page).toHaveTitle('ZTab');
  await expect(page.getByText('Testnet')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-wasm', 'ready', { timeout: 5000 });
  expect([...hosts].filter((h) => h !== '127.0.0.1' && h !== 'localhost')).toEqual([]);
});

test('built index.html has no inline code', () => {
  const html = readFileSync('dist/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  expect(scripts.length).toBeGreaterThan(0);
  for (const [, attrs, body] of scripts) {
    expect(body.trim()).toBe('');
    expect(attrs).toMatch(/\bsrc="/);
  }
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
});
