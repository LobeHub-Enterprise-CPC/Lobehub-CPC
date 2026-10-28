import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { isTenantMarketMode } from '@/libs/trusted-client/config';
import { MarketActingAsOrganizationUnavailableError } from '@/server/services/market/organizationGuard';

/**
 * Acting as an organization is closed inside a tenant (R13): Market refuses a
 * request that names an organization account. These guards refuse first and say
 * so, so a workspace flow fails visibly instead of publishing as the person.
 */
const unavailable = (operation: string) =>
  new MarketActingAsOrganizationUnavailableError(operation).message;

/**
 * The `actAs` input of a Market write: the organization account the write is
 * attributed to. Accepted outside a tenant as before; inside one any value is
 * a validation failure carrying `MARKET_ACTING_AS_ORGANIZATION_UNAVAILABLE`.
 */
export const actAsInput = z
  .number()
  .int()
  .positive()
  .optional()
  .refine((value) => value === undefined || !isTenantMarketMode(), {
    message: unavailable('actAs'),
  });

/**
 * For an operation that targets the caller's workspace organization (the
 * `workspace:<id>` endpoints): inside a tenant there is no such organization to
 * reach, and falling back to the personal account would act on different data.
 */
export const assertNoOrganizationScopeInTenant = (workspaceId: string | null | undefined) => {
  if (!workspaceId || !isTenantMarketMode()) return;

  throw new TRPCError({ code: 'FORBIDDEN', message: unavailable('workspace') });
};
