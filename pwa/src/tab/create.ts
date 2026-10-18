import {
  createMaster,
  deriveAddress,
  deriveTabAccount,
  deriveTabKeys,
  hashToken,
  sealBlob,
  type Network,
  type TabKeys,
  type TabMode,
} from '@ztab/crypto';
import { ApiClient, ApiRequestError, type CreateTabBody, type CreateTabResult } from '../api/client.ts';
import { centsToZat } from '../domain/money.ts';
import { toBase64, type AdminBlob, type BlobParticipant, type GroupBlob, type ParticipantBlob } from './blobs.ts';
import { tabUrl, zeroTabKeys } from './keys.ts';

export interface CreateInput {
  title: string;
  totalCents: number;
  usdPerZec: number;
  /** RFC 3339 time of the rate. */
  rateAt: string;
  mode: TabMode;
  participants: { name: string; shareCents: number }[];
  withdrawAddress: string;
}

export interface CreateDeps {
  api: ApiClient;
  network: Network;
  now: () => Date;
  /** e.g. `location.origin`; links are `${origin}/t/${tabId}#…`. */
  origin: string;
  /** Test seam; defaults to `createMaster` from @ztab/crypto. */
  createMaster?: () => Uint8Array;
}

export interface ParticipantLink {
  /** -1 for the single group link. */
  index: number;
  name: string;
  url: string;
}

export interface CreatedTab {
  tabId: string;
  adminUrl: string;
  /** One per participant (individual) or exactly one `{index: -1, name: 'Everyone'}` (group). */
  participantLinks: ParticipantLink[];
  /**
   * The tab's master secret, for the caller to keep in the admin session. The caller owns it:
   * `fill(0)` it once the admin leaves the Links/admin screens.
   */
  master: Uint8Array;
}

export class AddressMismatchError extends Error {
  constructor() {
    super('The server returned addresses that do not match this tab');
    this.name = 'AddressMismatchError';
  }
}

/**
 * The `PUT` got no response. The tab may or may not exist; the secrets are still held so the
 * UI **Retry** can resume. Call `retry()` (same tab id, identical body, admin Bearer) or
 * `abandon()` (zeroes master and tokens). A failed `retry()` throws a fresh CreateNetworkError.
 */
export class CreateNetworkError extends ApiRequestError {
  readonly tabId: string;
  readonly retry: () => Promise<CreatedTab>;
  readonly abandon: () => void;

  constructor(cause: ApiRequestError, tabId: string, retry: () => Promise<CreatedTab>, abandon: () => void) {
    super(cause.status, cause.code, cause.message);
    this.name = 'CreateNetworkError';
    this.tabId = tabId;
    this.retry = retry;
    this.abandon = abandon;
  }
}

const BIRTHDAY_MARGIN = 20;

/** Spec §5.1 / crypto-spec §5 "Creating a tab". */
export async function createTab(input: CreateInput, deps: CreateDeps): Promise<CreatedTab> {
  const { api, network, origin } = deps;
  const status = await api.status();
  if (status.tip_height === null || status.tip_height === undefined) {
    throw new ApiRequestError(503, 'watcher_unavailable', 'the chain tip is unknown');
  }
  const birthday = Math.max(0, status.tip_height - BIRTHDAY_MARGIN);
  const n = input.participants.length;

  const master = (deps.createMaster ?? createMaster)();
  const tabId = crypto.randomUUID();
  const keys = await deriveTabKeys(master, tabId, input.mode, n);
  let done = false;
  /** Final failure or abandon: nothing of this tab is kept. */
  const destroy = () => {
    if (done) return;
    done = true;
    master.fill(0);
    zeroTabKeys(keys);
  };

  let built: Built;
  try {
    built = await buildBody(input, network, keys, birthday, deps.now().toISOString());
  } catch (e) {
    destroy();
    throw e;
  }

  const { body, addresses, rows } = built;
  const finish = (result: CreateTabResult): CreatedTab => {
    try {
      checkAddresses(result, addresses);
      const adminUrl = tabUrl(origin, tabId, { kind: 'admin', master });
      const participantLinks: ParticipantLink[] = keys.group
        ? [{ index: -1, name: 'Everyone', url: tabUrl(origin, tabId, { kind: 'group', key: keys.group.raw }) }]
        : rows.map((r, i) => ({
            index: r.index,
            name: r.name,
            url: tabUrl(origin, tabId, { kind: 'participant', index: r.index, key: keys.participants![i].raw }),
          }));
      done = true;
      zeroTabKeys(keys);
      return { tabId, adminUrl, participantLinks, master };
    } catch (e) {
      destroy();
      throw e;
    }
  };

  // The first PUT carries no token. A lost response is not final: the row may exist, so the
  // retry re-sends the identical body with the admin Bearer (spec §5.1 Retry).
  const send = async (retry: boolean): Promise<CreatedTab> => {
    if (done) throw new Error('create_finished');
    let result: CreateTabResult;
    try {
      result = retry ? await api.retryCreate(tabId, body, keys.tokens.admin) : await api.createTab(tabId, body);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'network') {
        throw new CreateNetworkError(e, tabId, () => send(true), destroy);
      }
      destroy();
      throw e;
    }
    return finish(result);
  };
  return send(false);
}

interface Built {
  body: CreateTabBody;
  addresses: string[];
  rows: BlobParticipant[];
}

/** Derives the UFVK and local addresses (zeroing the spend key at once), seals the blobs, hashes the tokens. */
async function buildBody(
  input: CreateInput,
  network: Network,
  keys: TabKeys,
  birthday: number,
  createdAt: string,
): Promise<Built> {
  const n = input.participants.length;
  const account = deriveTabAccount(network, keys.spendSeed);
  account.orchardSk.fill(0);
  keys.spendSeed.fill(0);
  const { ufvk } = account;
  const addresses = Array.from({ length: n }, (_, i) => deriveAddress(network, ufvk, i));

  const rows = input.participants.map((p, index) => ({
    index,
    name: p.name,
    share_cents: p.shareCents,
    share_zat: centsToZat(p.shareCents, input.usdPerZec),
    address: addresses[index],
  }));
  const group: GroupBlob = {
    v: 1,
    title: input.title,
    currency: 'USD',
    total_cents: input.totalCents,
    rate_usd_per_zec: input.usdPerZec,
    rate_at: input.rateAt,
    mode: input.mode,
    participants: rows,
    created_at: createdAt,
  };
  const admin: AdminBlob = { ...group, withdraw_address: input.withdrawAddress };
  const seal = async (key: Parameters<typeof sealBlob>[0], value: unknown) => toBase64(await sealBlob(key, value));

  const body: CreateTabBody = {
    mode: input.mode,
    participants_count: n,
    ufvk,
    birthday,
    blobs: { admin: await seal(keys.admin, admin) },
    token_hashes: { admin: await hashToken(keys.tokens.admin) },
  };
  if (keys.group && keys.tokens.group) {
    body.blobs.group = await seal(keys.group, group);
    body.token_hashes.group = await hashToken(keys.tokens.group);
  } else {
    const pKeys = keys.participants ?? [];
    const pTokens = keys.tokens.participants ?? [];
    body.blobs.participants = await Promise.all(
      rows.map((r, i) => {
        const blob: ParticipantBlob = {
          v: 1,
          title: input.title,
          index: r.index,
          name: r.name,
          share_cents: r.share_cents,
          share_zat: r.share_zat,
          address: r.address,
          rate_usd_per_zec: input.usdPerZec,
          mode: input.mode,
        };
        return seal(pKeys[i], blob);
      }),
    );
    body.token_hashes.participants = await Promise.all(pTokens.map((t) => hashToken(t)));
  }
  return { body, addresses, rows };
}

function checkAddresses(result: CreateTabResult, local: string[]): void {
  const byIndex = new Map(result.addresses.map((a) => [a.index, a.address]));
  if (result.addresses.length !== local.length || local.some((address, i) => byIndex.get(i) !== address)) {
    throw new AddressMismatchError();
  }
}
