import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiClient, ApiRequestError } from '../api/client.ts';
import type { TabView } from '../api/types.ts';
import { config } from '../config.ts';
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
   * A failure the page must show: 404, 429 and other 4xx as `ApiRequestError`; a blob that
   * will not open as a synthetic `ApiRequestError(0, 'invalid_blob', …)`. Network failures and
   * 5xx are not errors: they keep the last view and set `stale`.
   */
  error: ApiRequestError | null;
  stale: boolean;
  refresh(): void;
}

const client = new ApiClient(config.apiUrl);

export function useTab(session: Session, intervalMs: number): TabState {
  const [state, setState] = useState<Omit<TabState, 'refresh'>>({ view: null, blob: null, error: null, stale: false });
  const opened = useRef<{ b64: string; blob: unknown } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const view = await client.getTab(session.tabId, session.token);
      if (opened.current?.b64 !== view.blob) {
        opened.current = { b64: view.blob, blob: await openTyped(session.blobKey, view.blob, SCHEMAS[session.role]) };
      }
      const blob = opened.current.blob;
      if (alive.current) setState({ view, blob, error: null, stale: view.stale });
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof BlobError) {
        setState((s) => ({ ...s, error: new ApiRequestError(0, 'invalid_blob', e.message) }));
      } else if (e instanceof ApiRequestError && e.status >= 400 && e.status < 500) {
        setState((s) => ({ ...s, error: e }));
      } else {
        setState((s) => ({ ...s, stale: true }));
      }
    }
  }, [session]);

  usePolling(load, intervalMs, true);

  return { ...state, refresh: () => void load() };
}
