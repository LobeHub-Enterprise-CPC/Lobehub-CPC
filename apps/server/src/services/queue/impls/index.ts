import { appEnv } from '@/envs/app';

import { HatchetQueueServiceImpl } from './hatchet';
import { LocalQueueServiceImpl } from './local';
import { type QueueServiceImpl } from './type';

/**
 * Check if queue-based agent runtime is enabled
 * Set via AGENT_RUNTIME_MODE=queue environment variable
 */
export const isQueueAgentRuntimeEnabled = (): boolean => {
  return appEnv.enableQueueAgentRuntime === true;
};

/**
 * Create queue service module
 *
 * When enableQueueAgentRuntime=true (AGENT_RUNTIME_MODE=queue):
 *   - HatchetQueueServiceImpl (production)
 *
 * When enableQueueAgentRuntime=false (default):
 *   - LocalQueueServiceImpl (local development, uses setTimeout for async execution)
 */
export const createQueueServiceModule = (): QueueServiceImpl => {
  if (isQueueAgentRuntimeEnabled()) return new HatchetQueueServiceImpl();

  // Local mode (default): use LocalQueueServiceImpl with callback mechanism
  return new LocalQueueServiceImpl();
};

export { LocalQueueServiceImpl } from './local';
export type { QueueServiceImpl } from './type';
