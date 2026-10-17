import { z } from 'zod';

/** 48 KB of base64url text (a proved sweep PCZT is far smaller). */
export const MAX_PCZT_B64 = 49_152;

export const sweepBodySchema = z
  .object({ recipient_address: z.string().min(1).max(512) })
  .strict();

export const broadcastBodySchema = z
  .object({
    pczt_b64: z
      .string()
      .min(1)
      .max(MAX_PCZT_B64)
      .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'must be base64url'),
  })
  .strict();

export type SweepBody = z.infer<typeof sweepBodySchema>;
export type BroadcastBody = z.infer<typeof broadcastBodySchema>;
