export type Network = 'test' | 'main';
export type TabMode = 'group' | 'individual';

/** What the browser keeps from a tab's spend seed. */
export interface TabAccount {
  ufvk: string;
  /** 32-byte Orchard spending key; zero it (`fill(0)`) as soon as the signature is made. */
  orchardSk: Uint8Array;
}

export interface PcztOutput {
  address: string;
  zat: number;
}

export interface PcztSummary {
  /** Every value-carrying Ironwood output. */
  outputs: PcztOutput[];
  feeZat: number;
  totalInZat: number;
  txid: string;
}

/** What `signPczt` checks the PCZT against before it signs. */
export interface SignExpectation {
  recipient: string;
  totalZat: number;
  feeZat: number;
}
