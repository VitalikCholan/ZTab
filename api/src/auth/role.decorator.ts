import { SetMetadata } from '@nestjs/common';
import type { TabRole } from './token.js';

export const ROLES_KEY = 'ztab:roles';

/** Restricts a route (or controller) to the given role kinds. */
export const Roles = (...kinds: TabRole['kind'][]) =>
  SetMetadata(ROLES_KEY, kinds);
