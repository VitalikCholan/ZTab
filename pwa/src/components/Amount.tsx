import { centsToUsdString, zatToZecString } from '../domain/money.ts';

/** `$12.50 ≈ 0.03121099 ZEC` */
export function Amount({ cents, zat }: { cents: number; zat: number }) {
  return (
    <p>
      <strong className="text-3xl font-bold text-fg">{centsToUsdString(cents)}</strong>{' '}
      <span className="font-mono text-muted">≈ {zatToZecString(zat)} ZEC</span>
    </p>
  );
}
