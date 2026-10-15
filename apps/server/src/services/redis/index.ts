import { deviceSystemInfo } from './deviceSystemInfo';
import { skillTools } from './skillTools';
import { tenantDiscovery } from './tenantDiscovery';
import { workspaceRescan } from './workspaceRescan';

/** Business Redis API. Providers, keys and expiry policy stay inside each domain. */
export const redisService = { deviceSystemInfo, skillTools, tenantDiscovery, workspaceRescan };
