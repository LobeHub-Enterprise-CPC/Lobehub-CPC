import '@/server/test-utils/serverTestConfig';

import { vi } from 'vitest';

export const assertGatewayProviderCapability = vi.fn().mockResolvedValue(undefined);
export const resolveLlmExecutionSite = vi.fn(async () => ({ site: 'server' as const }));
export const resolveProviderRelay = vi.fn().mockResolvedValue(undefined);
