import { config } from './config.ts';
import { useWasmState } from './wasm.ts';

export function App() {
  const wasm = useWasmState();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6 font-sans">
      <span className="w-fit rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
        {config.network === 'test' ? 'Testnet' : 'Mainnet'}
      </span>
      <h1 className="text-4xl font-bold">ZTab</h1>
      <p className="text-neutral-600">Split bills privately on shielded Zcash.</p>
      {wasm === 'failed' && (
        <p role="alert" className="text-red-700">
          Could not load the crypto module. Reload to try again.
        </p>
      )}
    </main>
  );
}
