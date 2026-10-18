import { centsToUsdString, zatToZecString } from '../domain/money.ts';

/** `$12.50 ≈ 0.03121099 ZEC` */
export function Amount({ cents, zat }: { cents: number; zat: number }) {
  return (
    <p>
      <strong className="text-3xl">{centsToUsdString(cents)}</strong>{' '}
      <span className="text-neutral-600">≈ {zatToZecString(zat)} ZEC</span>
    </p>
  );
}
