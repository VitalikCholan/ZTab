import type { RateResponse } from '../api/types.ts';

export type RateState = { kind: 'loading' } | { kind: 'ok'; rate: RateResponse } | { kind: 'failed' };

/** A manual rate: any positive finite number. */
export function parseRate(text: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function RateField({
  state,
  manual,
  onManual,
  onRefresh,
}: {
  state: RateState;
  manual: string;
  onManual: (v: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {state.kind === 'failed' ? (
        <>
          <label htmlFor="rate" className="font-medium">
            Rate, USD per ZEC
          </label>
          <input
            id="rate"
            inputMode="decimal"
            value={manual}
            onChange={(e) => onManual(e.target.value)}
            className="rounded border border-neutral-400 p-3"
          />
          <p className="text-sm text-neutral-600">Enter the rate manually</p>
        </>
      ) : (
        <p className="text-sm text-neutral-700">
          {state.kind === 'ok'
            ? `1 ZEC = $${state.rate.usd_per_zec} · updated ${hhmm(state.rate.fetched_at)}`
            : 'Loading rate…'}
        </p>
      )}
      <button type="button" onClick={onRefresh} className="w-fit rounded border border-neutral-400 px-3 py-2 text-sm">
        Refresh
      </button>
    </div>
  );
}
