import { z } from 'zod';

export const CONFIG = Symbol('CONFIG');

export interface Config {
  databaseUrl: string;
  watcherUrl: string;
  watcherToken: string;
  network: 'test' | 'main';
  corsOrigin: string;
  port: number;
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  WATCHER_URL: z.string().min(1).default('http://127.0.0.1:8080'),
  WATCHER_TOKEN: z.string().min(1),
  ZTAB_NETWORK: z.enum(['test', 'main']).default('test'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

/** Parses and validates the environment; throws naming the offending variables. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((i) => String(i.path[0]))),
    ];
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }
  const v = parsed.data;
  return {
    databaseUrl: v.DATABASE_URL,
    watcherUrl: v.WATCHER_URL,
    watcherToken: v.WATCHER_TOKEN,
    network: v.ZTAB_NETWORK,
    corsOrigin: v.CORS_ORIGIN,
    port: v.PORT,
  };
}
