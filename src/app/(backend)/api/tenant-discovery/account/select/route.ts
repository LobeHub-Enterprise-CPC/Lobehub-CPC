import { handleTenantAccount } from '@/server/services/tenantDiscovery/accountHttp';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleTenantAccount(request, 'select');
