import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiClient } from '../api/client.ts';
import { config } from '../config.ts';
import { PoweredByZcash } from '../components/PoweredByZcash.tsx';

const client = new ApiClient(config.apiUrl);

export function Landing() {
  const [synced, setSynced] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    client.status().then(
      (s) => alive && setSynced(s.watcher === 'ok'),
      () => alive && setSynced(false),
    );
    return () => {
      alive = false;
    };
  }, []);

  const net = config.network === 'test' ? 'Testnet' : 'Mainnet';
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6 font-sans">
      <span className="w-fit rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
        {synced === null ? net : `${net} · ${synced ? 'synced' : 'syncing…'}`}
      </span>
      <h1 className="text-4xl font-bold">ZTab</h1>
      <p className="text-neutral-600">Split bills privately on Zcash.</p>
      <Link to="/new" className="w-fit rounded bg-neutral-900 px-4 py-2 font-medium text-white">
        Create a tab
      </Link>
      {config.network === 'test' && (
        <p className="text-sm text-neutral-600">
          Paying needs a Zcash testnet wallet, e.g. Vizor Testnet.{' '}
          <a
            href="https://fauzec.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Get free testnet ZEC (TAZ)
          </a>
        </p>
      )}
      <PoweredByZcash />
    </main>
  );
}
