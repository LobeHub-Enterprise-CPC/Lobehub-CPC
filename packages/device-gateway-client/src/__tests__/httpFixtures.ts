import { expect } from 'vitest';

import type { GatewayHttpClientOptions } from '../http';

export const transport: Pick<
  GatewayHttpClientOptions,
  'tenantId' | 'execution' | 'prepareDispatch' | 'settleDispatch'
> = {
  settleDispatch: async () => {},
  tenantId: 'tenant-test',
  execution: { tenantId: 'tenant-test', sourceAcceptedVersion: 7 },
  prepareDispatch: async (input) => ({
    tenantId: 'tenant-test',
    sourceAcceptedVersion: 7,
    intent: {
      ...input,
      tenancyProtocol: 1,
      tenantId: 'tenant-test',
      sourceAcceptedVersion: 7,
      actor: { subject: 'user-1', sourceRef: 'source-test' },
      resourceId: input.resourceId || 'auto-device',
      attemptId: 'attempt-test',
      attemptExpiresAt: Date.now() + 30000,
    },
  }),
};
export const businessBody = (expected: unknown) => ({
  asymmetricMatch: (actual: string) =>
    expect.objectContaining(expected as object).asymmetricMatch(JSON.parse(actual)),
});
