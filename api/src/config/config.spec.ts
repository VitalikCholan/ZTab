import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  WATCHER_TOKEN: 'secret',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.network).toBe('test');
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.watcherToken).toBe('secret');
  });

  it('reads explicit values', () => {
    const cfg = loadConfig({
      ...base,
      WATCHER_URL: 'http://w:1',
      ZTAB_NETWORK: 'main',
      CORS_ORIGIN: 'https://ztab.app',
      PORT: '8081',
    });
    expect(cfg).toMatchObject({
      watcherUrl: 'http://w:1',
      network: 'main',
      corsOrigin: 'https://ztab.app',
      port: 8081,
    });
  });

  it('throws naming a missing WATCHER_TOKEN', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(
      /WATCHER_TOKEN/,
    );
  });

  it('throws naming a missing DATABASE_URL', () => {
    expect(() => loadConfig({ WATCHER_TOKEN: 'x' })).toThrow(/DATABASE_URL/);
  });

  it('throws on a bad ZTAB_NETWORK', () => {
    expect(() => loadConfig({ ...base, ZTAB_NETWORK: 'foo' })).toThrow(
      /ZTAB_NETWORK/,
    );
  });

  it('throws on a bad PORT', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });
});
