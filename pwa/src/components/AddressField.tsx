import type { Network } from '@ztab/crypto';

export type AddressCheck = 'unchecked' | 'valid' | 'invalid';

export function AddressField({
  value,
  check,
  network,
  onChange,
  onBlur,
}: {
  value: string;
  check: AddressCheck;
  network: Network;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const prefix = network === 'test' ? 'utest1' : 'u1';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="withdraw" className="font-medium">
        Your Zcash address for withdrawal
      </label>
      <input
        id="withdraw"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={check === 'invalid'}
        className="field font-mono text-sm break-all"
      />
      <p className={`text-sm ${check === 'invalid' ? 'text-danger' : 'text-muted'}`}>
        Use a unified address with an Orchard receiver ({network === 'test' ? 'testnet' : 'mainnet'} addresses start
        with {prefix}).
      </p>
    </div>
  );
}
