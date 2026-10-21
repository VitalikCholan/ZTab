// Invariant: amounts are integers (cents, zatoshi). The only float step is centsToZat.

const ZAT_PER_ZEC = 1e8;

export function centsToZat(cents: number, usdPerZec: number): number {
  return Math.round((cents / 100 / usdPerZec) * ZAT_PER_ZEC);
}

/** Up to 8 decimals, trailing zeros trimmed; integer div/mod, no float division. */
export function zatToZecString(zat: number): string {
  const whole = Math.floor(zat / ZAT_PER_ZEC);
  const frac = (zat % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${whole}.${frac}`;
}

export function centsToUsdString(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents must be a non-negative integer');
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Spec: the whole remainder goes to the first row, e.g. 5000/3 -> [1668, 1666, 1666]. */
export function splitEqually(totalCents: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  const base = Math.floor(totalCents / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? totalCents - base * (n - 1) : base));
}

export function sharesMatchTotal(shares: number[], totalCents: number): boolean {
  return shares.reduce((a, b) => a + b, 0) === totalCents;
}

/** Returns cents, or null for anything but digits with at most two decimals. */
export function parseUsdInput(text: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Fiat value of a zatoshi amount at the tab's fixed rate (display only), rounded to cents. */
export function zatToCents(zat: number, usdPerZec: number): number {
  return Math.round((zat / ZAT_PER_ZEC) * usdPerZec * 100);
}
