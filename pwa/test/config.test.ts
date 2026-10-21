import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const base = { VITE_API_URL: 'http://127.0.0.1:3000', VITE_NETWORK: 'test' };

describe('loadConfig', () => {
  it('parses a minimal env', () => {
    expect(loadConfig(base as unknown as ImportMetaEnv)).toEqual({
      apiUrl: 'http://127.0.0.1:3000',
      network: 'test',
      explorerTxUrl: null,
      demoPayment: false,
    });
  });
  it('throws naming a missing VITE_API_URL', () => {
    expect(() => loadConfig({ VITE_NETWORK: 'test' } as unknown as ImportMetaEnv)).toThrow(
      /VITE_API_URL/,
    );
  });
  it('rejects a bad VITE_NETWORK', () => {
    expect(() => loadConfig({ ...base, VITE_NETWORK: 'foo' } as unknown as ImportMetaEnv)).toThrow(
      /VITE_NETWORK/,
    );
  });
  it('accepts main and an explorer url', () => {
    const c = loadConfig({
      ...base,
      VITE_NETWORK: 'main',
      VITE_EXPLORER_TX_URL: 'https://x.test/tx/',
    } as unknown as ImportMetaEnv);
    expect(c.network).toBe('main');
    expect(c.explorerTxUrl).toBe('https://x.test/tx/');
  });
  it('treats an empty explorer url as null', () => {
    expect(
      loadConfig({ ...base, VITE_EXPLORER_TX_URL: '' } as unknown as ImportMetaEnv).explorerTxUrl,
    ).toBeNull();
  });
});
