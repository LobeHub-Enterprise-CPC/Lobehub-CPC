import { gatewayInternal } from '@/server/router-hono/gatewayInternal';

export const runtime = 'nodejs';
export const POST = (request: Request) => gatewayInternal.fetch(request);
