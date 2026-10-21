import app from '@/server/router-hono/tenantDiscoveryInternal';

export const dynamic = 'force-dynamic';

export const POST = (request: Request) => app.fetch(request);
