import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/governance';

const handler = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handler);
export const POST = withTenantRequest(handler);
export const PUT = withTenantRequest(handler);
export const DELETE = withTenantRequest(handler);
