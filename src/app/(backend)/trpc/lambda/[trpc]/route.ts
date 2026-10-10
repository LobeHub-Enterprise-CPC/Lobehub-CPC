import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { type NextRequest } from 'next/server';

import { createLambdaContext } from '@/libs/trpc/lambda/context';
import { createTRPCErrorLogger } from '@/libs/trpc/utils/errorLogger';
import { prepareRequestForTRPC } from '@/libs/trpc/utils/request-adapter';
import { createResponseMeta } from '@/libs/trpc/utils/responseMeta';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { lambdaRouter } from '@/server/routers/lambda';

// Some lambda mutations (e.g. video.createVideo) schedule a Next.js `after()`
// background job — most notably the video-generation poll loop, which can
// legitimately run for several minutes. Without this, the function is killed
// under the platform's default duration well before that finishes.
//
// Route segment config exports are statically analyzed by Next.js at build
// time, so this MUST be a literal — not a reference to an imported constant
// (that throws "Invalid segment configuration export detected" at build
// time). Keep in sync with TRPC_ASYNC_MAX_DURATION in
// packages/business/config/src/server/route.ts.
//
// 600s covers the video poll budget plus the step that stores the result; a window
// below VIDEO_GENERATION_POLL_TIMEOUT would kill the poll loop mid-flight, with no
// error thrown, and leave the watchdog to report the timeout.
export const maxDuration = 600;

const handler = (req: NextRequest) => {
  // Clone the request to avoid "Response body object should not be disturbed or locked" error
  // in Next.js 16 when the body stream has been consumed by Next.js internal mechanisms
  const preparedReq = prepareRequestForTRPC(req);

  return fetchRequestHandler({
    // Large-input queries (see the client's LARGE_INPUT_QUERY_PROCEDURES) are
    // sent as POST to dodge the GET URL length budget — let tRPC accept them.
    allowMethodOverride: true,

    /**
     * @link https://trpc.io/docs/v11/context
     */
    createContext: () => createLambdaContext(req),

    endpoint: '/trpc/lambda',

    onError: createTRPCErrorLogger('lambda'),

    req: preparedReq,
    responseMeta: createResponseMeta,
    router: lambdaRouter,
  });
};

const tenantHandler = withTenantRequest(handler);

export { tenantHandler as GET, tenantHandler as POST };
