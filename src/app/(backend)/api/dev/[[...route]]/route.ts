import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/devtools';

const handler = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handler);
export const POST = withTenantRequest(handler);
