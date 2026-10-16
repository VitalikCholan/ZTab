export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** The tab's master key (watcher-spec §4): 32 random bytes, lives only in the admin link. */
export function createMaster(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}
