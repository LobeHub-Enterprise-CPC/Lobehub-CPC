import { type GenericOAuthConfig } from 'better-auth/plugins';
import debug from 'debug';

import { type TenantSsoProvider, toGenericOAuthConfig } from '@/server/services/tenantSso';

const log = debug('lobe-server:tenant-sso');

/**
 * Tenant SSO runs on better-auth generic OAuth only. A tenant's `sso_providers`
 * row (written by Admin, secrets already opened) becomes one of two things,
 * the same set Admin serves its own sign-in from:
 * - `oidc` rows: generic OIDC discovery, whatever the `provider_id` is called.
 *   A row named `okta` or `google` is a plain OIDC client, never a vendor
 *   preset: the name is the tenant administrator's, not a selector.
 * - `oauth2` rows with `preset: 'custom'`: generic OAuth 2.0 with the saved
 *   endpoints.
 * Every other row (a named OAuth2 vendor an older build stored, an unusable
 * configuration) is left out on its own, so one bad row never takes the tenant's
 * other sign-in options down: SSO fails closed per provider.
 */

export interface TenantSsoProviderSet {
  /** better-auth generic OAuth configurations, one per runnable provider. */
  genericOAuthProviders: GenericOAuthConfig[];
  /** Provider ids better-auth serves through generic OAuth (`/oauth2/callback/{id}`). */
  genericProviderIds: string[];
  /** The tenant's providers this build can run, in their stable order. */
  providers: TenantSsoProvider[];
}

/**
 * better-auth providers for the tenant's enabled `sso_providers`.
 * `redirectURI(providerId)` is the tenant callback registered with the
 * identity provider (`/t/{slug}/api/auth/callback/{providerId}`).
 */
export const buildTenantSsoProviders = (
  providers: TenantSsoProvider[],
  redirectURI: (providerId: string) => string,
): TenantSsoProviderSet => {
  const result: TenantSsoProviderSet = {
    genericOAuthProviders: [],
    genericProviderIds: [],
    providers: [],
  };

  for (const provider of providers) {
    const config = toGenericOAuthConfig(provider, redirectURI(provider.providerId));
    if (!config) continue;
    result.genericOAuthProviders.push(config);
    result.genericProviderIds.push(provider.providerId);
    result.providers.push(provider);
  }

  // A count only: provider ids and configuration are the tenant's and can carry secrets.
  const skipped = providers.length - result.providers.length;
  if (skipped > 0)
    log('skipped %d of %d sso providers this build cannot run', skipped, providers.length);

  return result;
};
