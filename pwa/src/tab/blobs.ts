import { CryptoError, openBlob, type BlobKey } from '@ztab/crypto';
import { z } from 'zod';

// Spec §6: the JSON inside each AES-GCM blob. `.strict()` everywhere: unknown fields are refused.

const cents = z.number().int().nonnegative();
const zat = z.number().int().nonnegative();
const rate = z.number().positive();
const rfc3339 = z.iso.datetime({ offset: true });
const mode = z.enum(['group', 'individual']);

const participantRow = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    share_cents: cents,
    share_zat: zat,
    address: z.string().min(1),
  })
  .strict();

const groupShape = {
  v: z.literal(1),
  title: z.string().min(1),
  currency: z.literal('USD'),
  total_cents: cents,
  rate_usd_per_zec: rate,
  rate_at: rfc3339,
  mode,
  participants: z.array(participantRow).min(1),
  created_at: rfc3339,
};

export const groupBlobV1 = z.object(groupShape).strict();
export const adminBlobV1 = z.object({ ...groupShape, withdraw_address: z.string().min(1) }).strict();
export const participantBlobV1 = z
  .object({
    v: z.literal(1),
    title: z.string().min(1),
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    share_cents: cents,
    share_zat: zat,
    address: z.string().min(1),
    rate_usd_per_zec: rate,
    mode,
  })
  .strict();

export type AdminBlob = z.infer<typeof adminBlobV1>;
export type GroupBlob = z.infer<typeof groupBlobV1>;
export type ParticipantBlob = z.infer<typeof participantBlobV1>;
export type BlobParticipant = z.infer<typeof participantRow>;

export class BlobError extends Error {
  readonly code: 'decrypt_failed' | 'invalid_blob';

  constructor(code: 'decrypt_failed' | 'invalid_blob', message: string) {
    super(message);
    this.name = 'BlobError';
    this.code = code;
  }
}

/** Standard base64 with padding (the API's blob encoding). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Standard base64 or base64url, padded or not; `null` for anything else. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  const t = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64 → `openBlob` → schema. Fails with `decrypt_failed` (key/bytes) or `invalid_blob` (shape). */
export async function openTyped<S extends z.ZodType>(key: BlobKey, b64: string, schema: S): Promise<z.infer<S>> {
  const bytes = fromBase64(b64);
  if (!bytes) throw new BlobError('decrypt_failed', 'the blob is not base64');
  let value: unknown;
  try {
    value = await openBlob(key, bytes);
  } catch (e) {
    if (e instanceof CryptoError && e.code === 'decrypt_failed') {
      throw new BlobError('decrypt_failed', 'the blob cannot be opened with this key');
    }
    throw e;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BlobError('invalid_blob', 'the blob does not match its schema');
  return parsed.data;
}
