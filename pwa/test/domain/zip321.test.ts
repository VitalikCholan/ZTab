import { describe, expect, it } from 'vitest';
import { buildPaymentUri } from '../../src/domain/zip321';

describe('buildPaymentUri', () => {
  it('builds amount, message, label in order', () => {
    expect(buildPaymentUri('utest1abc', 100000, "Dinner — Bob's share")).toBe(
      `zcash:utest1abc?amount=0.001&message=${encodeURIComponent("Dinner — Bob's share")}&label=ZTab`,
    );
  });
  it('percent-encodes the dash and apostrophe-safe text', () => {
    const uri = buildPaymentUri('a', 1, 'Dinner — Bob');
    expect(uri).toContain('message=Dinner%20%E2%80%94%20Bob&');
  });
  it('cuts message to 100 chars', () => {
    const uri = buildPaymentUri('a', 100000000, 'x'.repeat(150));
    expect(uri).toContain(`amount=1&message=${'x'.repeat(100)}&label`);
  });
});
