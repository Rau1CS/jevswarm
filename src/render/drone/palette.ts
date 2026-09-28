/** Role identity colours shared by the fleet renderer, markers and the TECH page. */
import type { Role } from '../../sim/drone';

export const ROLE_COLOR: Record<Role, number> = {
  SCOUT: 0xd4d8db,
  SUPPRESSION: 0xc4452c,
  LOGISTICS: 0xdaa52a,
  RELAY: 0x6f7c88,
};
export const ROLE_MARK: Record<Role, number> = {
  SCOUT: 0xe8eef2,
  SUPPRESSION: 0xff7048,
  LOGISTICS: 0xffc240,
  RELAY: 0x8fb5d8,
};
export const ROLES: Role[] = ['SCOUT', 'SUPPRESSION', 'LOGISTICS', 'RELAY'];
