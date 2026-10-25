import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiClient, ApiRequestError } from '../api/client.ts';
import type { TabView } from '../api/types.ts';
import { config } from '../config.ts';
import { blobCommit, COMMIT_BYTES } from '@ztab/crypto';
import { adminBlobV1, BlobError, groupBlobV1, openTyped, participantBlobV1 } from '../tab/blobs.ts';
import type { Session } from '../tab/keys.ts';
import { usePolling } from './usePolling.ts';

const SCHEMAS: Record<Session['role'], z.ZodType> = {
  admin: adminBlobV1,
  group: groupBlobV1,
  participant: participantBlobV1,
};

export interface TabState {
  view: TabView | null;
  /** The role's decrypted blob; narrow it with the matching `*BlobV1` type. */
  blob: unknown | null;
  /**
   * Admin: always true. Group/participant: the blob hashes to the commitment in the link. False
   * (or no commitment) means a server re-sealed the blob: show the mismatch, never offer to pay.
   */
  verified: boolean;
  /**
   * A failure the page must show: 404, 429 and other 4xx as `ApiRequestError`; a blob that
   * will not open as a synthetic `ApiRequestError(0, 'invalid_blob', …)`. Network failures and
   * 5xx are not errors: they keep the last view and set `stale`.
   */
  error: ApiRequestError | null;
  stale: boolean;
  refresh(): void;
}

/** Constant-time full-length comparison; a missing or wrong-length commitment never verifies. */
function commitMatches(want: Uint8Array | undefined, got: Uint8Array): boolean {
  if (!want || want.length !== COMMIT_BYTES || got.length !== COMMIT_BYTES) return false;
  let diff = 0;
  for (let i = 0; i < COMMIT_BYTES; i++) diff |= want[i]! ^ got[i]!;
  return diff === 0;
}

const RATE_LIMIT_BACKOFF_MS = 60_000;

const client = new ApiClient(config.apiUrl);

export function useTab(session: Session, intervalMs: number): TabState {
  const [state, setState] = useState<Omit<TabState, 'refresh'>>({ view: null, blob: null, verified: false, error: null, stale: false });
  const opened = useRef<{ b64: string; blob: unknown; verified: boolean } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<number | void> => {
    try {
      const view = await client.getTab(session.tabId, session.token);
      if (opened.current?.b64 !== view.blob) {
        const blob = await openTyped(session.blobKey, view.blob, SCHEMAS[session.role]);
        const verified = session.role === 'admin' || commitMatches(session.commit, await blobCommit(blob));
        opened.current = { b64: view.blob, blob, verified };
      }
      const { blob, verified } = opened.current;
      if (alive.current) setState({ view, blob, verified, error: null, stale: view.stale });
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof BlobError) {
        setState((s) => ({ ...s, error: new ApiRequestError(0, 'invalid_blob', e.message) }));
      } else if (e instanceof ApiRequestError && e.status >= 400 && e.status < 500) {
        setState((s) => ({ ...s, error: e }));
        if (e.status === 429) return RATE_LIMIT_BACKOFF_MS;
      } else {
        setState((s) => ({ ...s, stale: true }));
      }
    }
  }, [session]);

  // 404 and an unreadable blob will not fix themselves: stop. 429: the limit is per minute, back off.
  const terminal = state.error?.status === 404 || state.error?.code === 'invalid_blob';
  usePolling(load, intervalMs, !terminal);

  return { ...state, refresh: () => void load() };
}
