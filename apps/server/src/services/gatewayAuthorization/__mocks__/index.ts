import '@/server/test-utils/serverTestConfig';

import { vi } from 'vitest';

import type * as GatewayAuthorizationModule from '../index';

const actual = await vi.importActual<typeof GatewayAuthorizationModule>(
  '@/server/services/gatewayAuthorization',
);
export const assertGatewayVersion = actual.assertGatewayVersion;
export const mintGatewayTicket = actual.mintGatewayTicket;
export const mintOperationGatewayTicket = vi.fn(async () => ({ token: 'test-operation-ticket' }));

export const mintGatewayEnrollment = actual.mintGatewayEnrollment;
