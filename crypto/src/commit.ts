/** Length of a blob content commitment carried in reader links. */
export const COMMIT_BYTES = 16;

const encoder = new TextEncoder();

/** `JSON.stringify` with object keys sorted recursively; arrays keep their order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

/** First 16 bytes of SHA-256 over the UTF-8 canonical JSON of `value`. */
export async function blobCommit(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(value)));
  return new Uint8Array(digest).slice(0, COMMIT_BYTES);
}
