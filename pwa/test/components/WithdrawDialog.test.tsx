import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CryptoError, inspectPczt, loadWasm } from '@ztab/crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SweepOffer } from '../../src/api/types.ts';
import { WithdrawDialog } from '../../src/components/WithdrawDialog.tsx';
import { checkWithdraw, type PreparedWithdraw } from '../../src/tab/withdraw.ts';
import { tabExpected as E, tabSweepPczt } from '../helpers/fixtures.ts';

// Same module as test/helpers/wasm.ts loads. Under jsdom, Vite rewrites that helper's static
// `new URL('…wasm', import.meta.url)` into an asset URL, so the path is built at run time here.
const WASM = join(dirname(fileURLToPath(import.meta.url)), '../../../crypto/pkg/ztab_crypto_bg.wasm');
beforeAll(() => loadWasm(new Uint8Array(readFileSync(WASM))));
afterEach(cleanup);

/** A real PreparedWithdraw from the proved fixture PCZT, exactly as prepareWithdraw builds it. */
function prepared(over: Partial<SweepOffer['summary']> = {}): PreparedWithdraw {
  const pczt = tabSweepPczt();
  const inspected = inspectPczt('test', pczt);
  const serverSummary = { inputs_zat: E.totalInZat, output_zat: 1990000, fee_zat: 10000, expiry_height: 1_000_000, txid: E.txid, ...over };
  return { pczt, inspected, serverSummary, recipient: E.recipient, ...checkWithdraw(inspected, serverSummary, E.recipient) };
}

const byText = (text: string) => screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text);

function mount(p: PreparedWithdraw, onConfirm = vi.fn(async () => ({ txid: E.txid }))) {
  const sweepStatus = vi.fn(async () => ({ state: 'sweeping' as const, txid: E.txid, mined_height: null, confirmations: 0, history: [] }));
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
});
