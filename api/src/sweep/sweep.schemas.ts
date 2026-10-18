import { z } from 'zod';

/** 48 KB of base64 text (a proved sweep PCZT is far smaller). */
export const MAX_PCZT_B64 = 49_152;
/** A real PCZT is never this short; also keeps 32-byte secrets out (spec §9). */
export const MIN_PCZT_B64 = 256;

const UA_PREFIX = { test: 'utest1', main: 'u1' } as const;

/**
 * Spec §9: no field outside `Authorization` may carry a secret-shaped value
 * (a 32-byte base64url token is 43 chars). The recipient must be a unified
 * address of this network, and the PCZT must be at least MIN_PCZT_B64 long.
 */
export function sweepBodySchema(network: 'test' | 'main') {
  const prefix = UA_PREFIX[network];
  return z
    .object({
      recipient_address: z
        .string()
        .startsWith(prefix, `must be a unified address starting with ${prefix}`)
        .max(512),
    })
    .strict();
}

/** The watcher accepts base64url and standard base64, padded or not. */
export const broadcastBodySchema = z
  .object({
    pczt_b64: z
      .string()
      .min(MIN_PCZT_B64)
      .max(MAX_PCZT_B64)
      .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'must be base64'),
  })
  .strict();

export type SweepBody = z.infer<ReturnType<typeof sweepBodySchema>>;
export type BroadcastBody = z.infer<typeof broadcastBodySchema>;
