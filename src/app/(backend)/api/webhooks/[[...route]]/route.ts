import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/webhooks';

const handle = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handle);
export const POST = withTenantRequest(handle);
