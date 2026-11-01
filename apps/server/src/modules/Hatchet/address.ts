import { parseTenantPath } from '@lobechat/business-tenant/routing';

import { INTERNAL_CALLBACKS } from '@/server/modules/Tenant/hostRouting';

interface DeliveryEnvironment {
  agentRuntimeBaseUrl?: string;
  appUrl: string;
  hostname?: string;
  internalAppUrl: string;
  port: string;
}

export const resolveDeliveryTarget = (
  url: string,
  env: DeliveryEnvironment,
): { loopback: false; url: URL } | { host: string; loopback: true; url: URL } => {
  const original = new URL(url);
  if (!['http:', 'https:'].includes(original.protocol) || original.username || original.password)
    throw new Error('Invalid delivery URL');

  const origins = [env.appUrl, env.internalAppUrl, env.agentRuntimeBaseUrl]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).origin);
  if (!origins.includes(original.origin)) return { loopback: false, url: original };

  let hostname = env.hostname || '127.0.0.1';
  if (hostname === '0.0.0.0') hostname = '127.0.0.1';
  if (hostname === '::') hostname = '::1';
  if (hostname.includes(':') && !hostname.startsWith('[')) hostname = '[' + hostname + ']';

  const { tenantSlug, rest } = parseTenantPath(original.pathname);
  const host =
    tenantSlug && INTERNAL_CALLBACKS.test(rest) ? new URL(env.internalAppUrl).host : original.host;
  return {
    host,
    loopback: true,
    url: new URL('http://' + hostname + ':' + env.port + original.pathname + original.search),
  };
};
