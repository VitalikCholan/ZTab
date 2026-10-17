import { toBase64Url } from './base64url.ts';

/** Lowercase hex SHA-256 of a token: the only form of it the API stores. */
export async function hashToken(token: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', token.slice()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `Authorization: Bearer` value: base64url without padding. */
export function encodeToken(token: Uint8Array): string {
  return toBase64Url(token);
}
