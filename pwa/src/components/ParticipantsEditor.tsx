import { centsToUsdString, centsToZat, parseUsdInput, splitEqually, zatToZecString } from '../domain/money.ts';

export const MAX_PARTICIPANTS = 20;

export interface Row {
  name: string;
  share: string;
}

export function ParticipantsEditor({
  rows,
  totalCents,
  usdPerZec,
  onChange,
}: {
  rows: Row[];
  totalCents: number | null;
  usdPerZec: number | null;
  onChange: (rows: Row[]) => void;
}) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const shares = rows.map((r) => parseUsdInput(r.share) ?? 0);
  const assigned = shares.reduce((a, b) => a + b, 0);
  const diff = totalCents === null ? 0 : totalCents - assigned;
  const splittable = totalCents !== null && totalCents > 0;

  return (
    <div className="card flex flex-col gap-3">
      <h2 className="font-medium">Participants</h2>
      {rows.map((r, i) => {
        const cents = parseUsdInput(r.share);
        return (
          <div key={i} className="flex flex-col gap-1 rounded-xl border border-line p-3">
            <div className="flex gap-2">
              <input
                aria-label={`Name ${i + 1}`}
                placeholder="Name"
                maxLength={40}
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value })}
                className="field min-w-0 flex-1"
              />
              <button
                type="button"
                aria-label={`Remove participant ${i + 1}`}
                disabled={rows.length <= 1}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="btn-secondary px-3"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span>$</span>
              <input
                aria-label={`Share USD ${i + 1}`}
                inputMode="decimal"
                placeholder="0.00"
                value={r.share}
                onChange={(e) => set(i, { share: e.target.value })}
                className="field min-w-0 flex-1"
              />
              <span className="text-sm text-muted">
                {cents !== null && cents > 0 && usdPerZec ? `≈ ${zatToZecString(centsToZat(cents, usdPerZec))} ZEC` : ''}
              </span>
            </div>
          </div>
        );
      })}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={rows.length >= MAX_PARTICIPANTS}
          onClick={() => onChange([...rows, { name: '', share: '' }])}
          className="btn-secondary"
        >
          Add participant
        </button>
        <button
          type="button"
          disabled={!splittable}
          onClick={() => onChange(rows.map((r, i) => ({ ...r, share: centsToUsdString(splitEqually(totalCents!, rows.length)[i]).slice(1) })))}
          className="btn-secondary"
        >
          Split equally
        </button>
      </div>
      {totalCents !== null && (
        <p className={diff === 0 ? 'text-muted' : 'text-danger'}>
          {`Assigned ${centsToUsdString(assigned)} of ${centsToUsdString(totalCents)}`}
          {diff > 0 && ` · ${centsToUsdString(diff)} left`}
          {diff < 0 && ` · ${centsToUsdString(-diff)} over`}
        </p>
      )}
    </div>
  );
}

