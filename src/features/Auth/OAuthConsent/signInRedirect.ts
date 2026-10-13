import { parseTenantPath, withTenantPath } from '@lobechat/business-tenant/routing';

/** Sign-in under the same tenant entry, returning to `current` once signed in. */
export const signInUrlFor = (current: URL): string => {
  const { tenantSlug } = parseTenantPath(current.pathname);
  const params = new URLSearchParams({ callbackUrl: current.href });
  return withTenantPath(`/signin?${params.toString()}`, tenantSlug);
};

export const redirectToSignIn = () => {
  window.location.replace(signInUrlFor(new URL(window.location.href)));
};
