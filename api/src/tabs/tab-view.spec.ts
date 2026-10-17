import { buildTabView, type TabViewInput } from './tab-view.js';
import type { WatcherTab } from '../watcher/watcher.types.js';

const tab: TabViewInput = {
  id: 'id-1',
  mode: 'individual',
  participantsCount: 2,
  paused: false,
  lastKnownState: 'open',
};
const addresses = [
  { index: 1, address: 'addr1' },
  { index: 0, address: 'addr0' },
];
const facts = (n: number) => ({
  confirmed_zat: n,
  mempool_zat: 0,
  best_confirmations: 1,
  transparent_source: false,
});
const watcher: WatcherTab = {
  tab_id: 'id-1',
  state: 'sweeping',
  active: true,
  synced_height: 90,
  tip_height: 100,
  stale: false,
  participants: [
    { index: 0, address: 'addr0', payments: [], status_facts: facts(5) },
    { index: 1, address: 'addr1', payments: [], status_facts: facts(7) },
  ],
};
const blob = Buffer.from('hello');

describe('buildTabView', () => {
  it('admin sees all participants', () => {
    const v = buildTabView(tab, addresses, blob, { kind: 'admin' }, watcher);
    expect(v.role).toBe('admin');
    expect(v.participant_index).toBeUndefined();
    expect(v.participants.map((p) => p.index)).toEqual([0, 1]);
    expect(v.participants[1].status_facts?.confirmed_zat).toBe(7);
    expect(v.blob).toBe(blob.toString('base64'));
    expect(v).toMatchObject({ state: 'sweeping', stale: false, synced_height: 90, tip_height: 100 });
  });

  it('group sees all participants', () => {
    const v = buildTabView(tab, addresses, blob, { kind: 'group' }, watcher);
    expect(v.role).toBe('group');
    expect(v.participants).toHaveLength(2);
  });

  it('participant 1 sees only its own entry', () => {
    const v = buildTabView(tab, addresses, blob, { kind: 'participant', index: 1 }, watcher);
    expect(v.role).toBe('participant');
    expect(v.participant_index).toBe(1);
    expect(v.participants).toEqual([
      { index: 1, address: 'addr1', payments: [], status_facts: facts(7) },
    ]);
  });

  it('paused tab is abandoned', () => {
    const v = buildTabView({ ...tab, paused: true }, addresses, blob, { kind: 'admin' }, null);
    expect(v.state).toBe('abandoned');
  });

  it('without watcher data: stale, no heights, empty payments, last known state', () => {
    const v = buildTabView({ ...tab, lastKnownState: 'closed' }, addresses, blob, { kind: 'admin' }, null);
    expect(v.stale).toBe(true);
    expect(v.state).toBe('closed');
    expect('synced_height' in v).toBe(false);
    expect('tip_height' in v).toBe(false);
    expect(v.participants.every((p) => p.payments.length === 0)).toBe(true);
    expect(v.participants.every((p) => p.status_facts === null)).toBe(true);
    expect(v.participants.map((p) => p.address)).toEqual(['addr0', 'addr1']);
  });

  it('keeps the watcher\'s own stale flag and its heights', () => {
    const v = buildTabView(tab, addresses, blob, { kind: 'admin' }, { ...watcher, stale: true });
    expect(v).toMatchObject({ stale: true, synced_height: 90, tip_height: 100 });
  });

  it('watcher missing an index: that index is null, others real', () => {
    const partial = { ...watcher, participants: [watcher.participants[0]] };
    const v = buildTabView(tab, addresses, blob, { kind: 'admin' }, partial);
    expect(v.stale).toBe(false);
    expect(v.participants[0].status_facts).toEqual(facts(5));
    expect(v.participants[1].status_facts).toBeNull();
  });

  it('matches watcher entries by index, ignores unknown indexes and extra fields', () => {
    const pay = {
      txid: 't',
      value_zat: 1,
      mined_height: null,
      confirmations: 0,
      transparent_source: false,
      first_seen_at: 'x',
      secret: 'leak',
    };
    const odd = {
      ...watcher,
      participants: [
        { index: 5, address: 'addr5', payments: [], status_facts: facts(9) },
        {
          index: 1,
          address: 'addr1',
          payments: [pay],
          status_facts: { ...facts(7), extra: 1 },
        },
      ],
    } as unknown as WatcherTab;
    const mine = buildTabView(tab, addresses, blob, { kind: 'participant', index: 1 }, odd);
    expect(mine.participants).toHaveLength(1);
    expect(mine.participants[0].status_facts).toEqual(facts(7));
    expect(mine.participants[0].payments).toEqual([
      {
        txid: 't',
        value_zat: 1,
        mined_height: null,
        confirmations: 0,
        transparent_source: false,
        first_seen_at: 'x',
      },
    ]);
    const all = buildTabView(tab, addresses, blob, { kind: 'admin' }, odd);
    expect(all.participants.map((p) => p.index)).toEqual([0, 1]);
    expect(all.participants[0].status_facts).toBeNull();
    expect(JSON.stringify(all)).not.toContain('leak');
  });
});
