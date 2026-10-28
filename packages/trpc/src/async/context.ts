import { type LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';
import { type NextRequest } from 'next/server';

const log = debug('lobe-async:context');

export interface AsyncAuthContext {
  authorizationToken?: string;
  serverDB?: LobeChatDatabase;
}

/**
 * Inner function for `createContext` where we create the context.
 * This is useful for testing when we don't want to mock Next.js' request/response
 */
export const createAsyncContextInner = async (params?: {
  authorizationToken?: string;
}): Promise<AsyncAuthContext> => ({
  authorizationToken: params?.authorizationToken,
});

export type AsyncContext = Awaited<ReturnType<typeof createAsyncContextInner>>;

export const createAsyncRouteContext = async (request: NextRequest): Promise<AsyncContext> => {
  // for API-response caching see https://trpc.io/docs/v11/caching

  log('Creating async route context');

  const authorization = request.headers.get('Authorization');

  log('Authorization header present: %s', !!authorization);

  if (!authorization) {
    log('No authorization header found');
    throw new Error('No authorization header found');
  }

  // The caller identity is inside the signed token (verified by `asyncAuth`
  // against the current tenant); no separate user header is trusted.
  return createAsyncContextInner({ authorizationToken: authorization });
};
