import type { TabRole } from '../auth/token.js';
import type {
  WatcherParticipant,
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
  /** The role's own blob, standard base64. */
  blob: string;
  participants: {
    index: number;
    address: string;
    payments: WatcherParticipant['payments'];
    status_facts: WatcherParticipant['status_facts'];
  }[];
}

export interface TabViewInput {
  id: string;
  mode: string;
  participantsCount: number;
  paused: boolean;
  lastKnownState: string;
}

const NO_FACTS = (): WatcherParticipant['status_facts'] => ({
  confirmed_zat: 0,
  mempool_zat: 0,
  best_confirmations: 0,
  transparent_source: false,
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
        payments: w?.payments ?? [],
        status_facts: w?.status_facts ?? NO_FACTS(),
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
    stale: watcher === null,
    role: role.kind,
    blob: Buffer.from(blob).toString('base64'),
    participants,
  };
  if (watcher) {
    view.synced_height = watcher.synced_height;
    view.tip_height = watcher.tip_height;
  }
  if (role.kind === 'participant') view.participant_index = role.index;
  return view;
}
