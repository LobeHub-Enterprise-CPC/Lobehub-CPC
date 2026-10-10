import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/agent';

const handler = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handler);
export const POST = withTenantRequest(handler);
