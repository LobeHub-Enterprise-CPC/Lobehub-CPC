import { receiveBusinessBridgeResult } from '@lobechat/business-auth';

import { withTenantRequest } from '@/server/modules/Tenant/gate';

export const POST = withTenantRequest(
  async (request: Request, context: { params: Promise<{ providerId: string }> }) =>
    receiveBusinessBridgeResult(request, (await context.params).providerId),
);
