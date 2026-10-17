import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Tab } from '../generated/prisma/client.js';
import { ROLES_KEY } from './role.decorator.js';
import { hashToken, parseBearer, roleFromToken, type TabRole } from './token.js';

export interface TabAuth {
  tab: Tab;
  role: TabRole;
}

export type TabAuthRequest = Request & { tabAuth: TabAuth };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `tab_id` + Bearer token to a role (spec §4) and enforces
 * `@Roles(...)`. Stateless singleton: all state lives on the request.
 */
@Injectable()
export class TabAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const token = parseBearer(req.headers.authorization);
    if (!token) {
      throw new ApiError(401, 'unauthorized', 'missing or malformed token');
    }

    // Unknown tab, malformed id and foreign token all look the same.
    const notFound = () => new ApiError(404, 'not_found', 'tab not found');
    const tabId = req.params.tab_id;
    if (typeof tabId !== 'string' || !UUID.test(tabId)) throw notFound();

    const computed = hashToken(token);
    const row = await this.prisma.tabToken.findFirst({
      where: { tabId, tokenHash: computed },
      include: { tab: true },
    });
    // Defence in depth: the row was found by this very hash.
    if (
      !row ||
      !timingSafeEqual(Buffer.from(row.tokenHash), computed)
    ) {
      throw notFound();
    }

    const role = roleFromToken(row, row.tab.participantsCount);
    if (!role) throw notFound();

    const required = this.reflector.getAllAndOverride<
      TabRole['kind'][] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (required && !required.includes(role.kind)) {
      throw new ApiError(403, 'forbidden', 'this link cannot do that');
    }

    (req as TabAuthRequest).tabAuth = { tab: row.tab, role };
    return true;
  }
}
