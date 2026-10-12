import { receiveBusinessBridgeResult } from '@lobechat/business-auth';

export const POST = async (
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) => receiveBusinessBridgeResult(request, (await context.params).providerId);
