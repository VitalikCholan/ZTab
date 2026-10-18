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
      <p className="break-all font-mono text-sm">{address}</p>
      <p className="text-sm">{zatToZecString(zat)} ZEC</p>
      <div className="flex flex-wrap gap-3">
        <CopyButton text={address} label="Copy address" onDone={onPayClicked} />
        <CopyButton text={zatToZecString(zat)} label="Copy amount" onDone={onPayClicked} />
      </div>
    </div>
  );

  if (mode === 'desktop') {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Pay with your wallet</h2>
        {details}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-4">
      <a href={uri} onClick={onPayClicked} className="block rounded bg-neutral-900 px-4 py-4 text-center text-lg font-semibold text-white">
        Pay with your wallet
      </a>
      <details>
        <summary className="cursor-pointer py-2">Other ways to pay</summary>
        {details}
      </details>
    </section>
  );
}
