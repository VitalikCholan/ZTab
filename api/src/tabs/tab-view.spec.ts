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
    expect(v.participants[1].status_facts.confirmed_zat).toBe(7);
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
    expect(v.participants.map((p) => p.address)).toEqual(['addr0', 'addr1']);
  });
});
