import { describe, expect, it } from 'vitest';

import fixture from '../../../../../../contracts/tenant-control-plane/endpoints.json';
import { endpointRequestSchema } from '../endpointsContract';

describe('endpoint snapshot contract', () => {
  it('accepts the frozen default and custom fixtures', () => {
    expect(endpointRequestSchema.parse(fixture.request)).toEqual(fixture.request);
    expect(endpointRequestSchema.parse(fixture.customRequest)).toEqual(fixture.customRequest);
  });
  it.each([
    { ...fixture.request, pathPrefix: '/t/other' },
    { ...fixture.request, version: 2147483648 },
    {
      ...fixture.customRequest,
      endpoints: fixture.customRequest.endpoints.map((e) => ({ ...e, active: true })),
    },
    ...[
      'Chat.example.com',
      'chat.example.com:443',
      'https://chat.example.com',
      '127.0.0.1',
      'a..example.com',
    ].map((host) => ({
      ...fixture.customRequest,
      endpoints: [
        fixture.customRequest.endpoints[0],
        { ...fixture.customRequest.endpoints[1], host },
      ],
    })),
    {
      ...fixture.customRequest,
      endpoints: [...fixture.customRequest.endpoints, fixture.customRequest.endpoints[1]],
    },
  ])('rejects malformed or ambiguous snapshots', (input) => {
    expect(endpointRequestSchema.safeParse(input).success).toBe(false);
  });
});
