import { withTenantRequest } from '@/server/modules/Tenant/gate';
import app from '@/server/router-hono/composio';

const handleGet = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handleGet);
