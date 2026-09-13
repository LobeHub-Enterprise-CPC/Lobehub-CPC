import { isWellFormedTenantSlug, TENANT_PREFIX } from '@lobechat/const/tenantPath';

import { WORKSPACE_MIRRORED_FIRST_SEGMENTS } from '@/features/Workspace/workspaceAwarePath';

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
]);

export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.has(slug.toLowerCase());

/** Syntactically well-formed AND not shadowing a real route. */
export const isRegistrableSlug = (slug: string): boolean =>
  isWellFormedTenantSlug(slug) && !isReservedSlug(slug);
