import type { CreatedTab } from './create.ts';

export interface CreatedSummary {
  title: string;
  usdPerZec: number;
  participants: { name: string; shareCents: number }[];
}

// Router state is structured-cloned into history.state, which browsers persist to disk, so the
// links (keys in fragments) travel through this in-memory hand-over instead. A reload loses them.
const pending = new Map<string, { created: CreatedTab; summary: CreatedSummary }>();

export const pendingCreated = {
  put(created: CreatedTab, summary: CreatedSummary): void {
    pending.set(created.tabId, { created, summary });
  },
  /** Non-destructive so a StrictMode double render keeps working; `discard` ends the hand-over. */
  peek(tabId: string) {
    return pending.get(tabId);
  },
  discard(tabId: string): void {
    pending.delete(tabId);
  },
};
