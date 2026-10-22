import { agentSignal } from './agentSignal';
import { deviceSystemInfo } from './deviceSystemInfo';
import { gatewayAuthorization } from './gatewayAuthorization';
import { linear } from './linear';
import { skillTools } from './skillTools';
import { steerQueue } from './steerQueue';
import { tenantDiscovery } from './tenantDiscovery';
import { threadStartFence } from './threadStartFence';
import { workspaceRescan } from './workspaceRescan';

/** Business Redis API. Providers, keys and expiry policy stay inside each domain. */
export const redisService = {
  agentSignal,
  deviceSystemInfo,
  gatewayAuthorization,
  linear,
  skillTools,
  steerQueue,
  tenantDiscovery,
  threadStartFence,
  workspaceRescan,
};
