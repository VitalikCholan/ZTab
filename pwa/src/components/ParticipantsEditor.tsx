import { centsToUsdString, centsToZat, parseUsdInput, splitEqually } from '../domain/money.ts';

export const MAX_PARTICIPANTS = 20;

export interface Row {
  name: string;
  share: string;
}

/** `≈` display value: rounded to 4 decimals, enough for a person to read. */
export function zecApprox(zat: number): string {
  return (Math.round(zat / 1e4) / 1e4).toFixed(4);
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
    <div className="flex flex-col gap-3">
      <h2 className="font-medium">Participants</h2>
      {rows.map((r, i) => {
        const cents = parseUsdInput(r.share);
        return (
          <div key={i} className="flex flex-col gap-1 rounded border border-neutral-300 p-3">
            <div className="flex gap-2">
              <input
                aria-label={`Name ${i + 1}`}
                placeholder="Name"
                maxLength={40}
                value={r.name}
                onChange={(e) => set(i, { name: e.target.value })}
                className="min-w-0 flex-1 rounded border border-neutral-400 p-3"
              />
              <button
                type="button"
                aria-label={`Remove participant ${i + 1}`}
                disabled={rows.length <= 1}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="rounded border border-neutral-400 px-3 disabled:opacity-40"
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
                className="min-w-0 flex-1 rounded border border-neutral-400 p-3"
              />
              <span className="text-sm text-neutral-600">
                {cents !== null && cents > 0 && usdPerZec ? `≈ ${zecApprox(centsToZat(cents, usdPerZec))} ZEC` : ''}
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
          className="rounded border border-neutral-400 px-4 py-3 disabled:opacity-40"
        >
          Add participant
        </button>
        <button
          type="button"
          disabled={!splittable}
          onClick={() => onChange(rows.map((r, i) => ({ ...r, share: centsToUsdString(splitEqually(totalCents!, rows.length)[i]).slice(1) })))}
          className="rounded border border-neutral-400 px-4 py-3 disabled:opacity-40"
        >
          Split equally
        </button>
      </div>
      {totalCents !== null && (
        <p className={diff === 0 ? 'text-neutral-700' : 'text-red-700'}>
          {`Assigned ${centsToUsdString(assigned)} of ${centsToUsdString(totalCents)}`}
          {diff > 0 && ` · ${centsToUsdString(diff)} left`}
          {diff < 0 && ` · ${centsToUsdString(-diff)} over`}
        </p>
      )}
    </div>
  );
}

