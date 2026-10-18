import { z } from 'zod';

/** Each decoded blob may be at most 16 KB (spec §4). */
export const MAX_BLOB_BYTES = 16 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard base64 (canonical, padded) of 1..16 KB. */
const blobSchema = z.string().superRefine((s, ctx) => {
  if (s.length === 0 || s.length % 4 !== 0 || !BASE64.test(s)) {
    ctx.addIssue({ code: 'custom', message: 'must be standard base64' });
    return;
  }
  const bytes = Buffer.from(s, 'base64');
  if (bytes.toString('base64') !== s) {
    ctx.addIssue({ code: 'custom', message: 'must be canonical base64' });
  } else if (bytes.length > MAX_BLOB_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'blob larger than 16 KB' });
  }
});

/** SHA-256 token hash: 64 lowercase hex characters. */
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex');

const blobsSchema = z
  .object({
    admin: blobSchema,
    group: blobSchema.optional(),
    participants: z.array(blobSchema).optional(),
  })
  .strict();

const hashesSchema = z
  .object({
    admin: hashSchema,
    group: hashSchema.optional(),
    participants: z.array(hashSchema).optional(),
  })
  .strict();

const UFVK_PREFIX = { test: 'uviewtest', main: 'uview1' } as const;

/** Body of PUT /tabs/{id} (spec §5); `network` fixes the UFVK prefix. */
export function createTabSchema(network: 'test' | 'main') {
  const prefix = UFVK_PREFIX[network];
  return z
    .object({
      mode: z.enum(['group', 'individual']),
      participants_count: z.number().int().min(1).max(20),
      ufvk: z
        .string()
        .startsWith(prefix, `must start with ${prefix}`)
        .max(2048),
      birthday: z.number().int().min(0).max(2_147_483_647),
      blobs: blobsSchema,
      token_hashes: hashesSchema,
    })
    .strict()
    .superRefine((v, ctx) => {
      const fail = (path: (string | number)[], message: string) =>
        ctx.addIssue({ code: 'custom', path, message });
      for (const key of ['blobs', 'token_hashes'] as const) {
        const part = v[key];
        if (v.mode === 'group') {
          if (part.group === undefined) fail([key, 'group'], 'required in group mode');
          if (part.participants !== undefined)
            fail([key, 'participants'], 'not allowed in group mode');
        } else {
          if (part.group !== undefined)
            fail([key, 'group'], 'not allowed in individual mode');
          if (part.participants?.length !== v.participants_count)
            fail(
              [key, 'participants'],
              'must have exactly participants_count entries in individual mode',
            );
        }
      }
      const hashes = [
        v.token_hashes.admin,
        v.token_hashes.group,
        ...(v.token_hashes.participants ?? []),
      ].filter((h): h is string => h !== undefined);
      if (new Set(hashes).size !== hashes.length)
        fail(['token_hashes'], 'token hashes must be distinct');
    });
}

export type CreateTabInput = z.infer<ReturnType<typeof createTabSchema>>;
