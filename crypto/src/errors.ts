export type CryptoErrorCode =
  | 'invalid_fragment'
  | 'decrypt_failed'
  | 'invalid_recipient'
  | 'invalid_pczt'
  | 'pczt_mismatch'
  | 'sign_failed'
  | 'wasm_unavailable'
  | 'internal';

const CODES: ReadonlySet<string> = new Set<CryptoErrorCode>([
  'invalid_fragment',
  'decrypt_failed',
  'invalid_recipient',
  'invalid_pczt',
  'pczt_mismatch',
  'sign_failed',
  'wasm_unavailable',
  'internal',
]);

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/** Turns an error thrown by the WASM module (`"<code>: <message>"`) into a CryptoError. */
export function fromWasmError(e: unknown): CryptoError {
  if (e instanceof CryptoError) return e;
  const text = e instanceof Error ? e.message : String(e);
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
  if (m && CODES.has(m[1])) return new CryptoError(m[1] as CryptoErrorCode, m[2]);
  return new CryptoError('internal', text);
}
