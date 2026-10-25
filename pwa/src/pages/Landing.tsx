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
      <span className="pill w-fit border-accent/40 bg-accent/10 text-accent">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
        {synced === null ? net : `${net} · ${synced ? 'synced' : 'syncing…'}`}
      </span>
      <h1 className="text-5xl font-extrabold tracking-tight text-fg">ZTab</h1>
      <p className="text-muted">Split bills privately on Zcash.</p>
      <Link to="/new" className="btn-primary w-fit">
        Create a tab
      </Link>
      {config.network === 'test' && (
        <p className="text-sm text-muted">
          Paying needs a Zcash testnet wallet, e.g. Vizor Testnet.{' '}
          <a
            href="https://fauzec.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            Get free testnet ZEC (TAZ)
          </a>
        </p>
      )}
      <PoweredByZcash />
    </main>
  );
}
