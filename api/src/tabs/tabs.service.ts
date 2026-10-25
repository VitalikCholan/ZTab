import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TabRole } from '../auth/token.js';
import { hashToken, parseBearer } from '../auth/token.js';
import { ApiError } from '../common/api-error.js';
import { CONFIG, type Config } from '../config/config.js';
import { Prisma, type Tab } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WatcherClient } from '../watcher/watcher.client.js';
import type { WatcherTab } from '../watcher/watcher.types.js';
import type { CreateTabInput } from './create-tab.schema.js';
import { buildTabView, type TabView } from './tab-view.js';

const ACTIVITY_INTERVAL_MS = 60_000;

/** Watcher is down, or has lost this tab: serve the stored snapshot. */
function isStaleCause(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    (e.code === 'watcher_unavailable' ||
      (e.code === 'watcher_rejected' && e.status === 404))
  );
}

type Role = 'admin' | 'group' | 'participant';
interface Entry {
  role: Role;
  index: number | null;
  value: string;
}

export interface CreateTabResult {
  status: 200 | 201;
  body: { tab_id: string; addresses: { index: number; address: string }[] };
}

/** Flattens `{admin, group?, participants?}` into role/index rows. */
function entries(part: {
  admin: string;
  group?: string;
  participants?: string[];
}): Entry[] {
  return [
    { role: 'admin', index: null, value: part.admin },
    ...(part.group !== undefined
      ? [{ role: 'group' as const, index: null, value: part.group }]
      : []),
    ...(part.participants ?? []).map((value, index) => ({
      role: 'participant' as const,
      index,
      value,
    })),
  ];
}

const key = (e: { role: string; index: number | null }) =>
  `${e.role}:${e.index ?? ''}`;

@Injectable()
export class TabsService {
  private readonly logger = new Logger(TabsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watcher: WatcherClient,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async create(
    rawId: string,
    input: CreateTabInput,
    authorization?: string,
  ): Promise<CreateTabResult> {
    const id = rawId.toLowerCase();
    const blobs = entries(input.blobs);
    const hashes = entries(input.token_hashes);

    const existing = await this.prisma.tab.findUnique({
      where: { id },
      include: { addresses: true, tokens: true },
    });
    if (existing) return this.retry(existing, input, blobs, authorization);

    // Register first: if the watcher refuses, nothing is stored.
    let addresses: { index: number; address: string }[];
    try {
      const registered = await this.watcher.registerTab({
        tab_id: id,
        ufvk: input.ufvk,
        birthday: input.birthday,
        participants_count: input.participants_count,
      });
      addresses = this.checkedAddresses(registered, input.participants_count);
    } catch (e) {
      // A timeout or 5xx may still have registered the tab at the watcher.
      // A 4xx refusal registered nothing.
      if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) {
        await this.pauseOrphan(id);
      }
      throw e;
    }

    try {
      // A nested create is a single transaction: tab, addresses, blobs, tokens.
      await this.prisma.tab.create({
        data: {
          id,
          mode: input.mode,
          participantsCount: input.participants_count,
          ufvk: input.ufvk,
          birthday: input.birthday,
          network: this.config.network,
          addresses: { create: addresses },
          blobs: {
            create: blobs.map((b) => ({
              role: b.role,
              index: b.index,
              ciphertext: Buffer.from(b.value, 'base64'),
            })),
          },
          tokens: {
            create: hashes.map((h) => ({
              role: h.role,
              index: h.index,
              tokenHash: Buffer.from(h.value, 'hex'),
            })),
          },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.pauseOrphan(id);
        throw new ApiError(409, 'conflict', 'tab or token already exists');
      }
      await this.pauseOrphan(id);
      throw e;
    }
    return { status: 201, body: { tab_id: id, addresses } };
  }

  /**
   * Best effort: stop the watcher scanning a tab we failed to store. Never
   * throws and never changes the response the client gets.
   */
  private async pauseOrphan(id: string): Promise<void> {
    try {
      await this.watcher.setActive(id, false);
    } catch (e) {
      this.logger.warn(
        `could not pause an unstored watcher tab: ${e instanceof ApiError ? e.code : 'unknown error'}`,
      );
    }
  }

  /**
   * The watcher's answer is untrusted input to our database: exactly one
   * address per participant, indexes 0..n-1, each a unified address of this
   * network. Anything else is a watcher fault (503), and nothing is stored.
   */
  private checkedAddresses(
    registered: unknown,
    count: number,
  ): { index: number; address: string }[] {
    const bad = () =>
      new ApiError(503, 'watcher_unavailable', 'watcher returned invalid addresses');
    const list = (registered as { addresses?: unknown } | null)?.addresses;
    if (!Array.isArray(list) || list.length !== count) throw bad();
    const prefix = this.config.network === 'main' ? 'u1' : 'utest1';
    const out: { index: number; address: string }[] = [];
    const seen = new Set<number>();
    for (const item of list as { index?: unknown; address?: unknown }[]) {
      const { index, address } = item ?? {};
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= count ||
        seen.has(index) ||
        typeof address !== 'string' ||
        !address.startsWith(prefix)
      ) {
        throw bad();
      }
      seen.add(index);
      out.push({ index, address });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /**
   * A repeated PUT (e.g. after a dropped response). Only an identical
   * registration is accepted: same ufvk, mode, count, birthday and exactly the
   * stored token hashes. Token hashes are never changed here, because
   * replacing them would lock out participants who already hold the old
   * tokens. The admin token must be presented as a Bearer header. Every blob of the tab is replaced in one transaction.
   */
  private async retry(
    existing: Prisma.TabGetPayload<{ include: { addresses: true; tokens: true } }>,
    input: CreateTabInput,
    blobs: Entry[],
    authorization: string | undefined,
  ): Promise<CreateTabResult> {
    // Defence in depth: a retry must also prove the admin token. A missing,
    // malformed or wrong token gets the same 409 as any other mismatch.
    const adminRow = existing.tokens.find((t) => t.role === 'admin');
    const presented = parseBearer(authorization);
    const authorized =
      adminRow !== undefined &&
      presented !== null &&
      timingSafeEqual(hashToken(presented), Buffer.from(adminRow.tokenHash));
    const stored = new Map(
      existing.tokens.map((t) => [key(t), Buffer.from(t.tokenHash).toString('hex')]),
    );
    const sent = entries(input.token_hashes);
    const same =
      existing.ufvk === input.ufvk &&
      existing.mode === input.mode &&
      existing.participantsCount === input.participants_count &&
      existing.birthday === input.birthday &&
      stored.size === sent.length &&
      sent.every((h) => stored.get(key(h)) === h.value);
    if (!authorized || !same) {
      throw new ApiError(409, 'conflict', 'tab already exists with different parameters');
    }

    try {
      await this.prisma.$transaction([
        this.prisma.tabBlob.deleteMany({ where: { tabId: existing.id } }),
        this.prisma.tabBlob.createMany({
          data: blobs.map((b) => ({
            tabId: existing.id,
            role: b.role,
            index: b.index,
            ciphertext: Buffer.from(b.value, 'base64'),
          })),
        }),
      ]);
    } catch (e) {
      // A concurrent retry can collide on the blob unique key.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ApiError(409, 'conflict', 'tab or token already exists');
      }
      throw e;
    }
    const addresses = existing.addresses
      .map(({ index, address }) => ({ index, address }))
      .sort((a, b) => a.index - b.index);
    return { status: 200, body: { tab_id: existing.id, addresses } };
  }

  /**
   * Reads a tab for an authenticated role. Never fails because the watcher is
   * unreachable or because bookkeeping writes fail: both degrade to a stale
   * or slightly outdated answer.
   */
  async read(tab: Tab, role: TabRole): Promise<TabView> {
    const id = tab.id;
    let watcher: WatcherTab | null = null;

    const reachable = await this.ensureActive(tab);
    const paused = tab.paused && !reachable;
    if (reachable) {
      try {
        const got = await this.watcher.getTab(id);
        // A malformed answer counts as no data rather than a 500.
        watcher = Array.isArray(got?.participants) ? got : null;
        if (watcher && watcher.active === false && !tab.paused) await this.heal(id);
      } catch (e) {
        if (!isStaleCause(e)) throw e;
        this.logger.warn(`watcher snapshot unavailable: ${(e as ApiError).code}`);
      }
    }

    const [addresses, blob] = await Promise.all([
      this.prisma.tabAddress.findMany({
        where: { tabId: id },
        orderBy: { index: 'asc' },
        select: { index: true, address: true },
      }),
      this.prisma.tabBlob.findFirst({
        where: {
          tabId: id,
          role: role.kind,
          index: role.kind === 'participant' ? role.index : null,
        },
        select: { ciphertext: true },
      }),
    ]);
    if (!blob) throw new ApiError(500, 'internal', 'tab data is incomplete');

    await this.recordActivity(tab, watcher);

    return buildTabView(
      { ...tab, paused },
      addresses,
      blob.ciphertext,
      role,
      watcher,
    );
  }

  /** The row says unpaused but the watcher has the tab inactive: re-activate, best effort. */
  private async heal(id: string): Promise<void> {
    try {
      await this.watcher.setActive(id, true);
    } catch (e) {
      this.logger.warn(
        `self-heal failed: ${e instanceof ApiError ? e.code : 'unknown error'}`,
      );
    }
  }

  /**
   * Revives a paused tab at the watcher and clears `paused` on success.
   * Returns false when the watcher cannot be reached (or has lost the tab);
   * any other failure propagates.
   */
  async ensureActive(tab: Tab): Promise<boolean> {
    if (!tab.paused) return true;
    const id = tab.id;
    try {
      await this.watcher.setActive(id, true);
    } catch (e) {
      if (!isStaleCause(e)) throw e;
      this.logger.warn(`revival failed: ${(e as ApiError).code}`);
      return false;
    }
    await this.bookkeeping(() =>
      this.prisma.tab.update({ where: { id }, data: { paused: false } }),
    );
    return true;
  }

  private async recordActivity(tab: Tab, watcher: WatcherTab | null) {
    const id = tab.id;
    const now = new Date();
    // Conditional update: concurrent polls write at most once a minute.
    await this.bookkeeping(() =>
      this.prisma.tab.updateMany({
        where: {
          id,
          lastAccessAt: { lt: new Date(now.getTime() - ACTIVITY_INTERVAL_MS) },
        },
        data: { lastAccessAt: now },
      }),
    );
    if (watcher) {
      const w = watcher;
      const changed = w.state !== tab.lastKnownState;
      const old =
        tab.lastKnownAt === null ||
        now.getTime() - tab.lastKnownAt.getTime() > ACTIVITY_INTERVAL_MS;
      if (changed || old) {
        await this.bookkeeping(() =>
          this.prisma.tab.update({
            where: { id },
            data: { lastKnownState: w.state, lastKnownAt: now },
          }),
        );
      }
      if (w.state === 'closed' && tab.closedAt === null) {
        // Set-once: a concurrent poll cannot move the timestamp.
        await this.bookkeeping(() =>
          this.prisma.tab.updateMany({
            where: { id, closedAt: null },
            data: { closedAt: now },
          }),
        );
      }
    }
  }

  /** A failed bookkeeping write must not fail the read; log the fact only. */
  private async bookkeeping(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch {
      this.logger.warn('tab bookkeeping write failed');
    }
  }
}
