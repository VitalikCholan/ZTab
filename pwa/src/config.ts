export type AppConfig = {
  apiUrl: string;
  network: 'test' | 'main';
  explorerTxUrl: string | null;
  demoPayment: false;
};

type Env = Record<string, unknown>;

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Pure parser so tests can pass plain objects. Throws on a missing or invalid setting. */
export function loadConfig(env: ImportMetaEnv | Env): AppConfig {
  const e = env as Env;
  const apiUrl = str(e, 'VITE_API_URL');
  if (!apiUrl) throw new Error('VITE_API_URL is required');
  const network = str(e, 'VITE_NETWORK');
  if (network !== 'test' && network !== 'main') {
    throw new Error(`VITE_NETWORK must be "test" or "main", got ${JSON.stringify(network ?? null)}`);
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    network,
    explorerTxUrl: str(e, 'VITE_EXPLORER_TX_URL') ?? null,
    demoPayment: false,
  };
}

export const config: AppConfig = loadConfig(import.meta.env);
