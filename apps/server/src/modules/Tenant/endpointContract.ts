import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import { withTenantPath } from '@lobechat/utils/tenantPath';
import { isTenantId } from '@lobechat/database/tenant';
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:-]+$/);
/** Console generates tenant ids as lower-case UUIDs (contracts/tenant-control-plane/tenant-naming.json). */
const tenantId = z.string().refine(isTenantId, 'TENANT_ID_INVALID');
const hostname = z
  .string()
  .max(253)
  .refine(
    (host) =>
      host === host.toLowerCase() &&
      host === domainToASCII(host) &&
      !isIP(host) &&
      host.includes('.') &&
      host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)),
  );
export const endpointSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.literal('default'),
      kind: z.literal('default'),
      host: z.null(),
      active: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: identifier.refine((id) => id !== 'default'),
      kind: z.literal('custom'),
      host: hostname,
      active: z.boolean(),
    })
    .strict(),
]);
export const endpointRequestSchema = z
  .object({
    tenantId,
    eventId: identifier,
    version: z.number().int().positive().max(2147483647),
    endpoints: z.array(endpointSchema).min(1).max(100),
  })
  .strict()
  .superRefine(({ endpoints }, ctx) => {
    if (
      endpoints.filter((e) => e.kind === 'default').length !== 1 ||
      endpoints.filter((e) => e.active).length !== 1 ||
      new Set(endpoints.map((e) => e.id)).size !== endpoints.length ||
      new Set(endpoints.filter((e) => e.host).map((e) => e.host)).size !==
        endpoints.filter((e) => e.host).length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Snapshot requires unique entries, one default and one active endpoint',
      });
  });
export const endpointQuerySchema = z.object({ tenantId: identifier }).strict();
export type TenantEndpoint = z.infer<typeof endpointSchema>;
export type EndpointRequest = z.infer<typeof endpointRequestSchema>;
export class TenantEndpointError extends Error {
  constructor(
    public readonly code:
      | 'ENDPOINTS_INVALID'
      | 'ENDPOINT_VERSION_CONFLICT'
      | 'ENDPOINT_HOST_CONFLICT'
      | 'ENDPOINTS_NOT_READY'
      | 'TENANT_DESTROYED'
      | 'TENANT_NOT_FOUND',
    public readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}

export const canonicalEndpointUrl = (
  appUrl: string,
  slug: string,
  endpoint: TenantEndpoint,
): string => {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new TenantEndpointError('ENDPOINTS_NOT_READY', 503);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new TenantEndpointError('ENDPOINTS_NOT_READY', 503);
  return endpoint.kind === 'custom'
    ? `https://${endpoint.host}`
    : `${url.origin}${withTenantPath('/', slug)}`;
};
