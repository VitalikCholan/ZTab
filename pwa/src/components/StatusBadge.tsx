import { BADGE_LABEL, type Badge } from '../domain/status.ts';

const TONE: Record<Badge, string> = {
  unknown: 'bg-neutral-200 text-neutral-800',
  waiting: 'bg-amber-100 text-amber-900',
  seen: 'bg-blue-100 text-blue-900',
  paid: 'bg-green-100 text-green-900',
  paid_transparent: 'bg-green-100 text-green-900',
  partial: 'bg-amber-100 text-amber-900',
  overpaid: 'bg-green-100 text-green-900',
};

export function StatusBadge({ badge }: { badge: Badge }) {
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-medium ${TONE[badge]}`}>{BADGE_LABEL[badge]}</span>;
}
