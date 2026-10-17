import { createHash } from 'node:crypto';

export const TOKEN_BYTES = 32;

export type TabRole =
  | { kind: 'admin' }
  | { kind: 'group' }
  | { kind: 'participant'; index: number };

/**
 * Parses `Authorization: Bearer <base64url(32 bytes)>`. Returns null for
 * anything else: wrong scheme, padding, other alphabets, wrong length.
 */
export function parseBearer(header: string | undefined): Buffer | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const encoded = parts[1];
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const token = Buffer.from(encoded, 'base64url');
  if (token.length !== TOKEN_BYTES) return null;
  // Reject non-canonical encodings (e.g. non-zero trailing bits).
  if (token.toString('base64url') !== encoded) return null;
  return token;
}

/** SHA-256 of the token; this is what the database stores. */
export function hashToken(token: Buffer): Buffer<ArrayBuffer> {
  return createHash('sha256').update(token).digest();
}
