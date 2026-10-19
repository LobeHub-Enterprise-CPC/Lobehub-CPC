import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/acceptance-review';

export const maxDuration = 300;
export const runtime = 'nodejs';

const handler = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handler);
export const POST = withTenantRequest(handler);
export const PATCH = withTenantRequest(handler);
export const DELETE = withTenantRequest(handler);
// A CORS preflight carries no credentials and is answered by the router's CORS middleware before
// any tenant data is read, so it does not depend on the tenant's lifecycle.
export const OPTIONS = handler;
