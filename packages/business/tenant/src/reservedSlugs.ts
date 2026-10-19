import { isWellFormedTenantSlug, TENANT_PREFIX } from './path';

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
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  TENANT_PREFIX,
  // Everything the workspace subtree mirrors.
  ...WORKSPACE_MIRRORED_FIRST_SEGMENTS,
  // The personal-only surfaces from PERSONAL_PATH_REGEX.
  'apps',
  'desktop-onboarding',
  'devtools',
  'invite',
  'me',
  'onboarding',
  'share',
  // Top-level routes in the proxy matcher that are neither of the above. A slug
  // matching one of these shadows a real page.
  'a',
  'acceptance',
  'auth-error',
  'changelog',
  'downloads',
  'goal',
  'goals',
  'labs',
  'market-auth-callback',
  'oauth',
  'oidc',
  'profile',
  'reset-password',
  'signin',
  'signup',
  'verify',
  'verify-email',
  'verify-im',
  // Reserved by Console (the slug registrar) or Admin for their own routes. A
  // slug any of the three apps reserves must be unregistrable everywhere, or
  // Console can register a tenant one of the apps cannot serve (spec A10).
  // Console's contracts.ts and Admin's wire.ts carry copies of this union.
  'admin',
  'api',
  'applications',
  'auth',
  'bootstrap',
  'console',
  'login',
  'logout',
  'register',
  'tenants',
  'users',
]);

export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.has(slug.toLowerCase());

/** Syntactically well-formed AND not shadowing a real route. */
export const isRegistrableSlug = (slug: string): boolean =>
  isWellFormedTenantSlug(slug) && !isReservedSlug(slug);
