import { stripTenantPath } from '@lobechat/business-tenant/routing';
import { type AnyRouter, TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { type TenantGateError } from './errors';

const TRPC_CODE: Record<number, TRPCError['code']> = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Answers a gate refusal of a tRPC request as a tRPC error for every call it carried.
 * The gate's bare `{ code }` body is not a tRPC response, so the client could only
 * report "Unable to transform response from server" and lose the refusal code; here
 * the code is the error message and the gate's status and headers are kept.
 */
export const trpcTenantRefusal =
  ({ endpoint, router }: { endpoint: string; router: AnyRouter }) =>
  (refusal: TenantGateError, request: Request): Promise<Response> => {
    const gateResponse = refusal.toResponse();
    const url = new URL(request.url);
    url.pathname = stripTenantPath(url.pathname);

    return fetchRequestHandler({
      allowMethodOverride: true,
      createContext: () => {
        throw new TRPCError({
          cause: refusal,
          code: TRPC_CODE[refusal.status],
          message: refusal.code,
        });
      },
      endpoint,
      // A refusal raised mid-handler arrives after the body was read; the calls'
      // inputs do not matter for a refusal, only their count and paths.
      req: request.bodyUsed
        ? new Request(url, { body: '{}', headers: request.headers, method: request.method })
        : new Request(url, request),
      responseMeta: () => ({ headers: gateResponse.headers, status: refusal.status }),
      router,
    });
  };
