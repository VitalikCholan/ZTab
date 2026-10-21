import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayPanel } from '../../src/components/PayPanel.tsx';
import { buildPaymentUri } from '../../src/domain/zip321.ts';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

afterEach(cleanup);
const props = { address: 'utest1abc', zat: 3121099, message: 'Dinner — Bob\'s share' };

describe('PayPanel', () => {
  it('phone: zcash anchor with the exact URI, QR inside Other ways to pay', async () => {
    const onPayClicked = vi.fn();
    render(<PayPanel {...props} mode="phone" onPayClicked={onPayClicked} />);
    const a = screen.getByRole('link', { name: 'Pay with your wallet' });
    expect(a).toHaveAttribute('href', buildPaymentUri(props.address, props.zat, props.message));
    expect(screen.getByText('Other ways to pay').closest('details')).not.toHaveAttribute('open');
    a.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(a);
    expect(onPayClicked).toHaveBeenCalledTimes(1);
  });

  it('desktop: QR and both copy buttons, no zcash anchor', () => {
    render(<PayPanel {...props} mode="desktop" onPayClicked={() => {}} />);
    expect(screen.getByRole('img', { name: 'QR code for payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy amount' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('copy amount writes the ZEC string and counts as paying', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onPayClicked = vi.fn();
    render(<PayPanel {...props} mode="desktop" onPayClicked={onPayClicked} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy amount' }));
    expect(writeText).toHaveBeenCalledWith('0.03121099');
    expect(onPayClicked).toHaveBeenCalled();
  });
});
