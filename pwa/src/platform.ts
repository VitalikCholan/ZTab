/** A phone-sized touch device: a wallet app can plausibly handle a zcash: link. */
export function isTouchPhone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 768;
}
