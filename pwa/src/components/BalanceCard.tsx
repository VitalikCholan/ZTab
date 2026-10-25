import { zatToZecString } from '../domain/money.ts';

export function BalanceCard({ collectedZat, sweptZat }: { collectedZat: number; sweptZat: number }) {
  return (
    <p className="card font-medium text-fg">
      {`Collected ${zatToZecString(collectedZat)} ZEC · Withdrawn ${zatToZecString(sweptZat)} ZEC`}
    </p>
  );
}
