import { withCurrentTenantPath } from '@lobechat/business-tenant/client';

/** Sign-in under the page's tenant entry, returning to `current` once signed in. */
export const signInUrlFor = (current: URL): string => {
  const params = new URLSearchParams({ callbackUrl: current.href });
  return withCurrentTenantPath(`/signin?${params.toString()}`);
};

export const redirectToSignIn = () => {
  window.location.replace(signInUrlFor(new URL(window.location.href)));
};
