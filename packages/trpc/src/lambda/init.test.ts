import { DATABASE_ERROR_PUBLIC_MESSAGE } from '@lobechat/utils/queryError';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { describe, expect, it } from 'vitest';

import { trpc } from './init';

const SQL =
  'Failed query: select "id" from "messages" where "id" = $1\nparams: msg_q9Utuc2kAGXSkuMutD';

const router = trpc.router({
  plainFailure: trpc.procedure.query(() => {
    throw new Error('Task not found');
  }),
  queryFailure: trpc.procedure.query(() => {
    throw new Error(SQL, { cause: new Error('Connection terminated unexpectedly') });
  }),
  wrappedQueryFailure: trpc.procedure.query(() => {
    throw new TRPCError({ cause: new Error(SQL), code: 'INTERNAL_SERVER_ERROR' });
  }),
});

const call = async (path: string) => {
  const response = await fetchRequestHandler({
    createContext: () => ({}) as any,
    endpoint: '/trpc',
    onError: () => {},
    req: new Request(`http://localhost/trpc/${path}`),
    router,
  });
  return response.text();
};

describe('lambda errorFormatter', () => {
  it.each(['queryFailure', 'wrappedQueryFailure'])(
    'answers a database failure without its SQL or parameters (%s)',
    async (path) => {
      const body = await call(path);

      expect(body).toContain(DATABASE_ERROR_PUBLIC_MESSAGE);
      expect(body).not.toMatch(/select|msg_q9Utuc2kAGXSkuMutD|Failed query/);
    },
  );

  it('keeps the message of other failures', async () => {
    expect(await call('plainFailure')).toContain('Task not found');
  });
});
