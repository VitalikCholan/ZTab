import { zeroSession, type Session } from './keys.ts';

// Module singleton: survives client-side navigation, not reloads (nothing is persisted).
const sessions = new Map<string, Session>();

export const sessionStore = {
  get(tabId: string): Session | undefined {
    return sessions.get(tabId);
  },
  /** Stores the tab's session; a different session it replaces is zeroed. */
  set(session: Session): void {
    const old = sessions.get(session.tabId);
    if (old && old !== session) zeroSession(old);
    sessions.set(session.tabId, session);
  },
  /** Forgets the tab and zeroes its secrets. */
  clear(tabId: string): void {
    const s = sessions.get(tabId);
    if (s) zeroSession(s);
    sessions.delete(tabId);
  },
};
