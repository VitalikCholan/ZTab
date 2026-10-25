import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CryptoError, inspectPczt, loadWasm } from '@ztab/crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SweepOffer, SweepStatus } from '../../src/api/types.ts';
import { WithdrawDialog } from '../../src/components/WithdrawDialog.tsx';
import { checkWithdraw, type PreparedWithdraw } from '../../src/tab/withdraw.ts';
import { recipientFixture, tabExpected as E, tabSweepPczt } from '../helpers/fixtures.ts';

// Same module as test/helpers/wasm.ts loads. Under jsdom, Vite rewrites that helper's static
// `new URL('…wasm', import.meta.url)` into an asset URL, so the path is built at run time here.
const WASM = join(dirname(fileURLToPath(import.meta.url)), '../../../crypto/pkg/ztab_crypto_bg.wasm');
beforeAll(() => loadWasm(new Uint8Array(readFileSync(WASM))));
afterEach(cleanup);

/** A real PreparedWithdraw from the proved fixture PCZT, exactly as prepareWithdraw builds it. */
function prepared(over: Partial<SweepOffer['summary']> = {}, recipient = E.recipient): PreparedWithdraw {
  const pczt = tabSweepPczt();
  const inspected = inspectPczt('test', pczt);
  const serverSummary = { inputs_zat: E.totalInZat, output_zat: 1990000, fee_zat: 10000, expiry_height: 1_000_000, txid: E.txid, ...over };
  return { pczt, inspected, serverSummary, recipient, ...checkWithdraw(inspected, serverSummary, recipient) };
}

const OUT = E.recipient; // the fixture PCZT's only output (Orchard-only UA)

const byText = (text: string) => screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text);

const SWEEPING: SweepStatus = { state: 'sweeping', txid: E.txid, mined_height: null, confirmations: 0, history: [] };

function mount(
  p: PreparedWithdraw,
  onConfirm = vi.fn(async () => ({ txid: E.txid })),
  sweepStatus = vi.fn(async (): Promise<SweepStatus> => SWEEPING),
) {
  render(<WithdrawDialog prepared={p} onConfirm={onConfirm} sweepStatus={sweepStatus} onClose={vi.fn()} />);
  return { onConfirm, sweepStatus };
}

describe('WithdrawDialog with the real fixture PCZT', () => {
  it('shows the PCZT amount, recipient and fee, and the server figure', () => {
    const p = prepared();
    expect(p.ok).toBe(true);
    mount(p);
    expect(byText('Send 0.0199 ZEC to utest1ar2v…gwc4d (your address) · fee 0.0001 ZEC')).toBeInTheDocument();
    expect(screen.getByTitle(E.recipient)).toHaveTextContent('utest1ar2v…gwc4d');
    expect(screen.getByText(E.recipient)).toBeInTheDocument(); // full address in <details>
    expect(byText('Server says: 0.0199 ZEC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('tampered summary: Confirm disabled with the sentence, nothing signed', async () => {
    const p = prepared({ output_zat: 1990001 });
    expect(p).toMatchObject({ ok: false, reason: 'amount' });
    const { onConfirm } = mount(p);
    // The displayed amount still comes from the PCZT, the server's claim is shown apart.
    expect(byText('Send 0.0199 ZEC to utest1ar2v…gwc4d (your address) · fee 0.0001 ZEC')).toBeInTheDocument();
    expect(byText('Server says: 0.01990001 ZEC')).toBeInTheDocument();
    expect(screen.getByText('The server proposed a different payment. Nothing was signed.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a CryptoError on confirm shows its code', async () => {
    mount(prepared(), vi.fn(async () => {
      throw new CryptoError('pczt_mismatch', 'x');
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Signing failed: pczt_mismatch')).toBeInTheDocument();
  });

  it('recipient mismatch: shows the PCZT output address as not yours, Confirm disabled, nothing signed', async () => {
    const other = E.addresses[0]!;
    expect(other).not.toBe(E.recipient);
    const p = prepared({}, other);
    expect(p).toMatchObject({ ok: false, reason: 'recipient' });
    const { onConfirm } = mount(p);
    expect(byText('Send 0.0199 ZEC to utest1ar2v…gwc4d (not your address) · fee 0.0001 ZEC')).toBeInTheDocument();
    expect(screen.getByText('(not your address)')).toHaveClass('text-danger');
    expect(screen.getByTitle(OUT)).toHaveTextContent('utest1ar2v…gwc4d');
    expect(screen.queryByText(other)).toBeNull();
    expect(screen.queryByText(/\(your address\)/)).toBeNull();
    expect(screen.getByText('The server proposed a different payment. Nothing was signed.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a multi-receiver wallet UA matches its Orchard-only output: your address', () => {
    const p = prepared({}, recipientFixture.multiReceiver);
    expect(p.ok).toBe(true);
    mount(p);
    expect(byText('Send 0.0199 ZEC to utest1ar2v…gwc4d (your address) · fee 0.0001 ZEC')).toBeInTheDocument();
    expect(screen.getByText(OUT)).toBeInTheDocument(); // the full address shown is the PCZT's
  });

  it('several outputs: each is listed with its own address and verdict', () => {
    const base = prepared();
    const other = E.addresses[1]!;
    const inspected = { ...base.inspected, outputs: [{ address: OUT, zat: 1000000 }, { address: other, zat: 990000 }] };
    const p = { ...base, inspected, ...checkWithdraw(inspected, base.serverSummary, E.recipient) };
    expect(p).toMatchObject({ ok: false, reason: 'recipient' });
    mount(p);
    expect(byText('Send 0.0199 ZEC · fee 0.0001 ZEC')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'LI' && el.textContent === '0.01 ZEC to utest1ar2v…gwc4d (your address)')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'LI' && el.textContent === `0.0099 ZEC to ${other.slice(0, 10)}…${other.slice(-5)} (not your address)`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('the tab back to open without the txid mined in history: the withdrawal expired', async () => {
    const sweepStatus = vi.fn(async (): Promise<SweepStatus> => ({ state: 'open', txid: null, mined_height: null, confirmations: 0, history: [] }));
    mount(prepared(), undefined, sweepStatus);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The withdrawal expired before it was mined; try again.');
    expect(sweepStatus).toHaveBeenCalled();
  });

  it('open with the txid mined in history keeps counting confirmations', async () => {
    const row = { txid: E.txid, output_zat: 1990000, fee_zat: 10000, mined_height: 120, confirmations: 1 };
    const sweepStatus = vi.fn(async (): Promise<SweepStatus> => ({ state: 'open', txid: null, mined_height: null, confirmations: 0, history: [row] }));
    mount(prepared(), undefined, sweepStatus);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(sweepStatus).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent(/Withdrawing… txid/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
