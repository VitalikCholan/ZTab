import { z } from 'zod';
import { describe, expect, it } from 'vitest';

describe('zod-config', () => {
  it('turns on jitless so zod never probes eval under the CSP', async () => {
    await import('../src/zod-config.ts');
    expect(z.config().jitless).toBe(true);
  });
});
