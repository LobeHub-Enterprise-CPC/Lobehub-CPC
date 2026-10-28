import reservedSlugs from '../../../../contracts/tenant-control-plane/reserved-slugs.json';
import { isWellFormedTenantSlug } from './path';

/**
 * First segments mirrored under `/:workspaceSlug`. Exported because the tenant
 * reserved-slug list is derived from it — a slug equal to one of these shadows
 * the real route, so the two must never drift apart.
 */
export const WORKSPACE_MIRRORED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'agent',
  'agents',
  'community',
  'eval',
  // Top-level goal detail lives beside task/tasks in the shared main area.
  'goal',
  'group',
  'image',
  'memory',
  'page',
  'project',
  'projects',
  'resource',
  'settings',
  'task',
  'tasks',
  'video',
]);

/**
 * Segments that can never be registered as a tenant slug or a workspace slug.
 *
 * The main-area route tree carries a `:workspaceSlug` segment, so ANY
 * unrecognised first segment is read as a slug rather than 404ing —
 * `spa/BootShell/routeScope.ts` documents the same hazard for the dev-proxy
 * prefix, where the prefix got eaten as a slug. A workspace named `agent` would
 * therefore shadow `/agent`, and the failure is silent: a 404 or the wrong page
 * renders, nothing throws.
 *
 * Blocking registration is the only point at which the shadowing can be
 * prevented rather than merely detected after someone reports a missing page.
 *
 * The list is Console's `reserved-slugs.json` (the union of what TITU Work, Admin and Console
 * serve at the first path segment): Console is the only registrar, so one file is the whole
 * truth. `tests/reservedSlugs.test.ts` fails when a route this application serves is missing
 * from it.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(reservedSlugs.slugs);

export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.has(slug.toLowerCase());

/** Syntactically well-formed AND not shadowing a real route. */
export const isRegistrableSlug = (slug: string): boolean =>
  isWellFormedTenantSlug(slug) && !isReservedSlug(slug);
