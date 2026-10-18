import { zatToZecString } from '../domain/money.ts';

export function BalanceCard({ collectedZat, sweptZat }: { collectedZat: number; sweptZat: number }) {
  return (
    <p className="rounded bg-neutral-100 p-3 font-medium">
      {`Collected ${zatToZecString(collectedZat)} ZEC · Withdrawn ${zatToZecString(sweptZat)} ZEC`}
    </p>
  );
}
