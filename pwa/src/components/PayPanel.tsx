import { zatToZecString } from '../domain/money.ts';
import { buildPaymentUri } from '../domain/zip321.ts';
import { CopyButton } from './CopyButton.tsx';
import { QrCode } from './QrCode.tsx';

interface Props {
  address: string;
  zat: number;
  message: string;
  mode: 'phone' | 'desktop';
  onPayClicked: () => void;
}

export function PayPanel({ address, zat, message, mode, onPayClicked }: Props) {
  const uri = buildPaymentUri(address, zat, message);
  const details = (
    <div className="flex flex-col items-start gap-3">
      <QrCode text={uri} />
      <p className="break-all font-mono text-sm text-fg">{address}</p>
      <p className="text-sm text-muted">{zatToZecString(zat)} ZEC</p>
      <div className="flex flex-wrap gap-3">
        <CopyButton text={address} label="Copy address" variant="secondary" onDone={onPayClicked} />
        <CopyButton text={zatToZecString(zat)} label="Copy amount" variant="secondary" onDone={onPayClicked} />
      </div>
    </div>
  );

  if (mode === 'desktop') {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Pay with your wallet</h2>
        {details}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <a href={uri} onClick={onPayClicked} className="btn-primary w-full">
        Pay with your wallet
      </a>
      <details>
        <summary className="cursor-pointer py-2 text-muted">Other ways to pay</summary>
        {details}
      </details>
    </section>
  );
}
