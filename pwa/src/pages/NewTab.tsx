import type { TabMode } from '@ztab/crypto';
import { validateRecipient } from '@ztab/crypto';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/instance.ts';
import { ApiRequestError } from '../api/client.ts';
import { AddressField, type AddressCheck } from '../components/AddressField.tsx';
import { ParticipantsEditor, zecApprox, type Row } from '../components/ParticipantsEditor.tsx';
import { parseRate, RateField, type RateState } from '../components/RateField.tsx';
import { config } from '../config.ts';
import { centsToZat, parseUsdInput, sharesMatchTotal } from '../domain/money.ts';
import { AddressMismatchError, createTab, CreateNetworkError, type CreatedTab, type CreateInput } from '../tab/create.ts';
import { useWasmState } from '../wasm.ts';
import type { LinksState } from './Links.tsx';

type Failure =
  | { kind: 'network'; error: CreateNetworkError }
  | { kind: 'api'; error: ApiRequestError }
  | { kind: 'mismatch' };

export function NewTab() {
  const navigate = useNavigate();
  const wasm = useWasmState();
  const [title, setTitle] = useState('');
  const [totalText, setTotalText] = useState('');
  const [rows, setRows] = useState<Row[]>([{ name: '', share: '' }]);
  const [mode, setMode] = useState<TabMode | null>(null);
  const [address, setAddress] = useState('');
  const [check, setCheck] = useState<AddressCheck>('unchecked');
  const [rate, setRate] = useState<RateState>({ kind: 'loading' });
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const alive = useRef(true);
  const lastInput = useRef<CreateInput | null>(null);
  const pending = useRef<CreateNetworkError | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Leaving after a network error abandons the half-created tab. Deferred a tick so
      // StrictMode's simulated unmount does not abandon a live screen.
      setTimeout(() => {
        if (!alive.current) {
          pending.current?.abandon();
          pending.current = null;
        }
      }, 0);
    };
  }, []);

  const loadRate = () => {
    setRate({ kind: 'loading' });
    api.rate().then(
      (r) => alive.current && setRate({ kind: 'ok', rate: r }),
      () => alive.current && setRate({ kind: 'failed' }),
    );
  };
  useEffect(loadRate, []);

  const totalCents = parseUsdInput(totalText);
  const usdPerZec = rate.kind === 'ok' ? rate.rate.usd_per_zec : rate.kind === 'failed' ? parseRate(manual) : null;
  const shares = rows.map((r) => parseUsdInput(r.share));

  const valid =
    title.trim() !== '' &&
    totalCents !== null &&
    totalCents > 0 &&
    rows.every((r, i) => r.name.trim() !== '' && shares[i] !== null && shares[i]! > 0) &&
    sharesMatchTotal(shares as number[], totalCents) &&
    mode !== null &&
    check === 'valid' &&
    usdPerZec !== null &&
    wasm === 'ready' &&
    failure?.kind !== 'network';

  const onBlurAddress = () => {
    if (address === '') return setCheck('unchecked');
    try {
      validateRecipient(config.network, address);
      setCheck('valid');
    } catch {
      setCheck('invalid');
    }
  };

  const succeed = (created: CreatedTab, input: CreateInput) => {
    pending.current = null;
    const state: LinksState = {
      created,
      summary: { title: input.title, usdPerZec: input.usdPerZec, participants: input.participants },
    };
    navigate('/new/links', { state });
  };

  const submit = async () => {
    if (!valid || usdPerZec === null || totalCents === null || mode === null) return;
    const input: CreateInput = {
      title: title.trim(),
      totalCents,
      usdPerZec,
      rateAt: rate.kind === 'ok' ? rate.rate.fetched_at : new Date().toISOString(),
      mode,
      participants: rows.map((r, i) => ({ name: r.name.trim(), shareCents: shares[i]! })),
      withdrawAddress: address.trim(),
    };
    lastInput.current = input;
    setBusy(true);
    setFailure(null);
    try {
      succeed(await createTab(input, { api, network: config.network, now: () => new Date(), origin: window.location.origin }), input);
    } catch (e) {
      fail(e);
    }
    // Navigating away unmounts; only reset if still here.
    if (alive.current) setBusy(false);
  };

  const fail = (e: unknown) => {
    if (e instanceof CreateNetworkError) {
      pending.current = e;
      setFailure({ kind: 'network', error: e });
    } else if (e instanceof AddressMismatchError) setFailure({ kind: 'mismatch' });
    else if (e instanceof ApiRequestError) setFailure({ kind: 'api', error: e });
    else setFailure({ kind: 'api', error: new ApiRequestError(0, 'unknown', 'Something went wrong') });
  };

  const retryNetwork = async (error: CreateNetworkError) => {
    setBusy(true);
    try {
      const created = await error.retry();
      const input = lastInput.current;
      if (input) succeed(created, input);
    } catch (e) {
      fail(e);
    }
    if (alive.current) setBusy(false);
  };

  const label = wasm === 'ready' ? (busy ? 'Creating…' : 'Create tab') : 'Loading crypto module…';
  const totalZec = totalCents && usdPerZec ? zecApprox(centsToZat(totalCents, usdPerZec)) : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 py-6 font-sans">
      <h1 className="text-2xl font-bold">New tab</h1>
      <fieldset disabled={busy} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <label htmlFor="title" className="font-medium">
            Tab name
          </label>
          <input
            id="title"
            maxLength={80}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded border border-neutral-400 p-3"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="total" className="font-medium">
            Total, USD
          </label>
          <input
            id="total"
            inputMode="decimal"
            value={totalText}
            onChange={(e) => setTotalText(e.target.value)}
            className="rounded border border-neutral-400 p-3"
          />
          {totalZec && <p className="text-sm text-neutral-600">{`≈ ${totalZec} ZEC`}</p>}
        </div>
        <RateField state={rate} manual={manual} onManual={setManual} onRefresh={loadRate} />
        <ParticipantsEditor rows={rows} totalCents={totalCents} usdPerZec={usdPerZec} onChange={setRows} />
        <div role="radiogroup" aria-label="Mode" className="flex flex-col gap-2">
          <label className="flex items-start gap-2 rounded border border-neutral-300 p-3">
            <input type="radio" name="mode" checked={mode === 'group'} onChange={() => setMode('group')} />
            <span>
              <b>Group</b>
              <br />
              <span className="text-sm text-neutral-600">one link, everyone sees everyone's status</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded border border-neutral-300 p-3">
            <input type="radio" name="mode" checked={mode === 'individual'} onChange={() => setMode('individual')} />
            <span>
              <b>Individual</b>
              <br />
              <span className="text-sm text-neutral-600">a separate link per person, each sees only their own share</span>
            </span>
          </label>
        </div>
        <AddressField
          value={address}
          check={check}
          network={config.network}
          onChange={(v) => {
            setAddress(v);
            setCheck('unchecked');
          }}
          onBlur={onBlurAddress}
        />
      </fieldset>

      {failure?.kind === 'mismatch' && (
        <p role="alert" className="text-red-700">The server returned addresses that do not match this tab</p>
      )}
      {failure?.kind === 'api' && (
        <div role="alert" className="flex flex-col gap-2 text-red-700">
          <p>{`Could not create the tab (${failure.error.code})`}</p>
          <button type="button" onClick={() => void submit()} className="w-fit rounded border border-red-700 px-4 py-3">
            Retry
          </button>
        </div>
      )}
      {failure?.kind === 'network' && (
        <div role="alert" className="flex flex-col gap-2 text-red-700">
          <p>No response from the server. The tab may or may not have been created.</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void retryNetwork(failure.error)}
              className="rounded border border-red-700 px-4 py-3 disabled:opacity-40"
            >
              Retry
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                failure.error.abandon();
                pending.current = null;
                setFailure(null);
              }}
              className="rounded border border-neutral-400 px-4 py-3 text-neutral-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        disabled={!valid || busy}
        onClick={() => void submit()}
        className="rounded bg-neutral-900 px-4 py-4 text-lg font-medium text-white disabled:opacity-40"
      >
        {label}
      </button>
    </main>
  );
}
