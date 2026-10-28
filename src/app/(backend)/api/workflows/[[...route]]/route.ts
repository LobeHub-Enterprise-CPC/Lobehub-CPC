import { withTenantRequestUrl } from '@/server/modules/Tenant/callbackUrl';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/workflows';

// Upstash Workflow schedules each next step at the URL of the request it is
// serving, so the handler sees the tenant address (`/t/{slug}/api/workflows/…`)
// the proxy routed, not the unprefixed route path.
const handlePost = (request: Request) => app.fetch(withTenantRequestUrl(request));

export const POST = withTenantRequest(handlePost);
