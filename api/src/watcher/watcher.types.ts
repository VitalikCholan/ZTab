/** Shapes of the watcher HTTP contract (watcher-spec §6, watcher README). */

export interface WatcherPayment {
  txid: string;
  value_zat: number;
  mined_height: number | null;
  confirmations: number;
  transparent_source: boolean;
  first_seen_at: string;
}

export interface WatcherStatusFacts {
  confirmed_zat: number;
  mempool_zat: number;
  best_confirmations: number;
  transparent_source: boolean;
}

export interface WatcherParticipant {
  index: number;
  address: string;
  payments: WatcherPayment[];
  status_facts: WatcherStatusFacts;
}

export type WatcherTabState = 'open' | 'sweeping' | 'closed';

export interface WatcherTab {
  tab_id: string;
  state: WatcherTabState;
  active: boolean;
  synced_height: number;
  tip_height: number;
  stale: boolean;
  participants: WatcherParticipant[];
  /** Present on current watchers; absent from older ones. */
  balance?: WatcherBalance;
}

export interface WatcherBalance {
  spendable_zat: number;
  pending_zat: number;
  swept_zat: number;
  min_unspent_confirmations: number | null;
  /** Value the next sweep would send after fee; absent from older watchers. */
  sweepable_zat?: number;
}

export interface WatcherSweepHistoryEntry {
  txid: string;
  output_zat: number;
  fee_zat: number;
  mined_height: number | null;
  confirmations: number;
}

export interface WatcherRegisterBody {
  tab_id: string;
  ufvk: string;
  birthday: number;
  participants_count: number;
}

export interface WatcherRegisterResult {
  tab_id: string;
  addresses: { index: number; address: string }[];
}

export interface WatcherSweepBody {
  recipient_address: string;
  memo?: string;
}

export interface WatcherSweepResult {
  pczt_b64: string;
  summary: {
    inputs_zat: number;
    output_zat: number;
    fee_zat: number;
    expiry_height: number;
    txid: string;
    pending_mempool_zat?: number;
    /** Mined unspent tab value this sweep leaves behind; absent from older watchers. */
    remaining_zat?: number;
  };
}

export interface WatcherBroadcastBody {
  pczt_b64: string;
}

export interface WatcherBroadcastResult {
  txid: string;
}

export interface WatcherSweepStatus {
  state: WatcherTabState;
  txid: string | null;
  mined_height: number | null;
  confirmations: number;
  /** Newest first. */
  history?: WatcherSweepHistoryEntry[];
}

export interface WatcherHealth {
  tip_height: number;
  synced_height: number;
  mempool_subscribed: boolean;
  lag_seconds: number;
}
