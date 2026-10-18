// Types only, no runtime code. Mirrors the API as built (api/src/tabs/tab-view.ts,
// watcher/watcher.types.ts, status, rate); amounts are integer zatoshi.

export interface Payment {
  txid: string;
  value_zat: number;
  mined_height: number | null;
  confirmations: number;
  transparent_source: boolean;
  first_seen_at: string;
}

export interface StatusFacts {
  confirmed_zat: number;
  mempool_zat: number;
  best_confirmations: number;
  transparent_source: boolean;
}

export interface Participant {
  index: number;
  address: string;
  payments: Payment[];
  /** null means unknown, never "unpaid". */
  status_facts: StatusFacts | null;
}

export interface Balance {
  spendable_zat: number;
  pending_zat: number;
  swept_zat: number;
  min_unspent_confirmations: number | null;
}

export interface TabView {
  tab_id: string;
  mode: string;
  participants_count: number;
  /** open | sweeping | closed | abandoned */
  state: string;
  synced_height?: number;
  tip_height?: number;
  stale: boolean;
  role: 'admin' | 'group' | 'participant';
  participant_index?: number;
  /** Admin and group only. */
  balance?: Balance;
  /** The role's own blob, standard base64. */
  blob: string;
  participants: Participant[];
}

export interface SweepOffer {
  pczt_b64: string;
  summary: {
    inputs_zat: number;
    output_zat: number;
    fee_zat: number;
    expiry_height: number;
    txid: string;
    pending_mempool_zat?: number;
  };
}

export interface SweepHistoryRow {
  txid: string;
  output_zat: number;
  fee_zat: number;
  mined_height: number | null;
  confirmations: number;
}

export interface SweepStatus {
  state: 'open' | 'sweeping' | 'closed';
  txid: string | null;
  mined_height: number | null;
  confirmations: number;
  /** Newest first. */
  history: SweepHistoryRow[];
}

export interface RateResponse {
  usd_per_zec: number;
  fetched_at: string;
  source: 'coingecko';
}

export interface StatusResponse {
  network: 'test' | 'main';
  tip_height: number | null;
  synced_height: number | null;
  lag_seconds: number | null;
  watcher: 'ok' | 'stale' | 'down';
  block_interval_seconds: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
