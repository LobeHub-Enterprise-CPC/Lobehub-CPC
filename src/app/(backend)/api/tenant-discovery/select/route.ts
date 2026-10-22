import { handleTenantDiscovery } from '@/server/services/tenantDiscovery/http';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleTenantDiscovery(request, 'select');
