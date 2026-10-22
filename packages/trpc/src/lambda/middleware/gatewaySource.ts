import { runWithGatewaySource } from '@/server/services/gatewayAuthorization/context';

import { trpc } from '../init';

export const gatewaySource = trpc.middleware(({ ctx, next }) =>
  runWithGatewaySource(ctx.gatewaySource, () => next()),
);
