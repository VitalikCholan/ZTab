// Invariant: pure string building; parameter order is amount, message, label.
import { zatToZecString } from './money';

// Constant by design: a wallet may copy it into the memo, which the server can read.
export const PAY_MESSAGE = 'ZTab share';

export function buildPaymentUri(address: string, zat: number, message: string): string {
  return `zcash:${address}?amount=${zatToZecString(zat)}&message=${encodeURIComponent(message.slice(0, 100))}&label=ZTab`;
}
