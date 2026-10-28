import { TRPCError } from '@trpc/server';

import { signWorkspaceDeviceToken } from '@/libs/trpc/utils/internalJwt';
import { requireGatewaySource } from '@/server/services/gatewayAuthorization/context';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

const authorizationErrorCodes = new Map<number, TRPCError['code']>([
  [400, 'BAD_REQUEST'],
  [401, 'UNAUTHORIZED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [501, 'NOT_IMPLEMENTED'],
  [503, 'SERVICE_UNAVAILABLE'],
]);

/** Preserve gateway authorization denials at the workspace device tRPC boundary. */
export const mintWorkspaceDeviceConnectToken = async (workspaceId: string, userId: string) => {
  try {
    return await signWorkspaceDeviceToken(workspaceId, requireGatewaySource(userId));
  } catch (error) {
    if (error instanceof GatewayAuthorizationError) {
      const code = authorizationErrorCodes.get(error.status);
      if (code) throw new TRPCError({ cause: error, code, message: error.code });
    }
    throw error;
  }
};
