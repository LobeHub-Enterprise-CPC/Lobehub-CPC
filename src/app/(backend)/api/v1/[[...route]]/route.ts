import lobeOpenApi from '@lobechat/openapi';

import { withTenantRequest } from '@/server/modules/Tenant/gate';

const handler = (request: Request) => lobeOpenApi.fetch(request);

// Export all required HTTP method handlers

export const GET = withTenantRequest(handler);
export const POST = withTenantRequest(handler);
export const PUT = withTenantRequest(handler);
export const DELETE = withTenantRequest(handler);
export const PATCH = withTenantRequest(handler);
export const OPTIONS = withTenantRequest(handler);
export const HEAD = withTenantRequest(handler);
