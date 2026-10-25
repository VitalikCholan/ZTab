import { BADGE_LABEL, type Badge } from '../domain/status.ts';

const ACCENT = 'border-accent/30 bg-accent/10 text-accent';
const OK = 'border-ok/30 bg-ok/10 text-ok';

const TONE: Record<Badge, string> = {
  unknown: 'border-line bg-surface text-muted',
  waiting: ACCENT,
  seen: ACCENT,
  paid: OK,
  paid_transparent: OK,
  partial: ACCENT,
  overpaid: OK,
};

const DOT: Record<Badge, string> = {
  unknown: 'bg-muted',
  waiting: 'bg-accent shadow-[0_0_8px_var(--color-accent)]',
  seen: 'bg-accent shadow-[0_0_8px_var(--color-accent)] motion-safe:animate-pulse',
  paid: 'bg-ok',
  paid_transparent: 'bg-ok',
  partial: 'bg-accent shadow-[0_0_8px_var(--color-accent)]',
  overpaid: 'bg-ok',
};

export function StatusBadge({ badge }: { badge: Badge }) {
  return (
    <span className={`pill ${TONE[badge]}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[badge]}`} />
      {BADGE_LABEL[badge]}
    </span>
  );
}
