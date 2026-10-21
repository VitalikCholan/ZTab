import type { TabRole } from '../auth/token.js';
import type {
  WatcherBalance,
  WatcherPayment,
  WatcherStatusFacts,
  WatcherTab,
} from '../watcher/watcher.types.js';

/** Response of `GET /tabs/{id}` (spec §6). Built explicitly, never from a DB row. */
export interface TabView {
  tab_id: string;
  mode: string;
  participants_count: number;
  /** `open | sweeping | closed` from the watcher, or `abandoned` when paused. */
  state: string;
  synced_height?: number;
  tip_height?: number;
  stale: boolean;
  role: 'admin' | 'group' | 'participant';
  participant_index?: number;
  /** Tab balance; admin and group only, never participants. */
  balance?: WatcherBalance;
  /** The role's own blob, standard base64. */
  blob: string;
  participants: {
    index: number;
    address: string;
    payments: WatcherPayment[];
    /**
     * `null` means "unknown": the watcher gave no facts for this index
     * (outage or stale snapshot). Clients must not read it as "unpaid".
     */
    status_facts: WatcherStatusFacts | null;
  }[];
}

export interface TabViewInput {
  id: string;
  mode: string;
  participantsCount: number;
  paused: boolean;
  lastKnownState: string;
}

/** Copies only the documented Payment fields (watcher-spec §6). */
const pickPayment = (p: WatcherPayment): WatcherPayment => ({
  txid: p.txid,
  value_zat: p.value_zat,
  mined_height: p.mined_height,
  confirmations: p.confirmations,
  transparent_source: p.transparent_source,
  first_seen_at: p.first_seen_at,
});

/** Copies only the documented status_facts fields (watcher-spec §6). */
const pickFacts = (f: WatcherStatusFacts): WatcherStatusFacts => ({
  confirmed_zat: f.confirmed_zat,
  mempool_zat: f.mempool_zat,
  best_confirmations: f.best_confirmations,
  transparent_source: f.transparent_source,
});

/** Copies only the documented balance fields. */
const pickBalance = (b: WatcherBalance): WatcherBalance => ({
  spendable_zat: b.spendable_zat,
  pending_zat: b.pending_zat,
  swept_zat: b.swept_zat,
  min_unspent_confirmations: b.min_unspent_confirmations,
});

/**
 * Pure assembly of the role slice. Addresses come from the database (so the
 * view works without the watcher); payments and facts from the watcher when it
 * answered, otherwise empty and `stale: true`.
 */
export function buildTabView(
  tab: TabViewInput,
  addresses: { index: number; address: string }[],
  blob: Uint8Array,
  role: TabRole,
  watcher: WatcherTab | null,
): TabView {
  const facts = new Map((watcher?.participants ?? []).map((p) => [p.index, p]));
  let participants = [...addresses]
    .sort((a, b) => a.index - b.index)
    .map(({ index, address }) => {
      const w = facts.get(index);
      return {
        index,
        address,
        payments: Array.isArray(w?.payments) ? w.payments.map(pickPayment) : [],
        status_facts: w?.status_facts ? pickFacts(w.status_facts) : null,
      };
    });
  if (role.kind === 'participant') {
    participants = participants.filter((p) => p.index === role.index);
  }

  const view: TabView = {
    tab_id: tab.id,
    mode: tab.mode,
    participants_count: tab.participantsCount,
    state: tab.paused ? 'abandoned' : (watcher?.state ?? tab.lastKnownState),
    stale: watcher === null || watcher.stale === true,
    role: role.kind,
    blob: Buffer.from(blob).toString('base64'),
    participants,
  };
  if (watcher) {
    view.synced_height = watcher.synced_height;
    view.tip_height = watcher.tip_height;
  }
  if (watcher?.balance && role.kind !== 'participant') {
    view.balance = pickBalance(watcher.balance);
  }
  if (role.kind === 'participant') view.participant_index = role.index;
  return view;
}
