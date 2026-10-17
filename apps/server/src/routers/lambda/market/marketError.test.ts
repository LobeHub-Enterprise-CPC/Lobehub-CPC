// @vitest-environment node
import { MarketAPIError } from '@lobehub/market-sdk';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { isMarketNotFound, mapMarketError } from './marketError';

const apiError = (status: number, message = 'upstream said so') =>
  new MarketAPIError(status, 'status text', { error: { code: 'X', message } });

describe('mapMarketError', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'TOO_MANY_REQUESTS'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const)(
    'keeps a Market %s as %s, so the client can tell it from an outage',
    (status, code) => {
      const mapped = mapMarketError(apiError(status), 'fallback');

      expect(mapped).toBeInstanceOf(TRPCError);
      expect(mapped.code).toBe(code);
    },
  );

  // UNAUTHORIZED drives the LobeHub re-login prompt; a Market 401 is not that.
  it('never turns a Market 401 into UNAUTHORIZED', () => {
    expect(mapMarketError(apiError(401), 'fallback').code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('keeps the cause, and says why identity could not be established', () => {
    const cause = new Error('MARKET_IDENTITY_UNAVAILABLE:TENANT_REQUIRED');

    const mapped = mapMarketError(cause, 'fallback');

    expect(mapped.code).toBe('INTERNAL_SERVER_ERROR');
    expect(mapped.message).toBe('MARKET_IDENTITY_UNAVAILABLE:TENANT_REQUIRED');
    expect(mapped.cause).toBe(cause);
  });

  it("does not hand an unknown error's message to the client unless asked to", () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:5432');

    expect(mapMarketError(cause, 'Failed to publish').message).toBe('Failed to publish');
    expect(mapMarketError(cause, 'Failed to publish', { exposeMessage: true }).message).toBe(
      'connect ECONNREFUSED 10.0.0.5:5432',
    );
  });

  it('leaves an error that is already a TRPCError alone', () => {
    const decided = new TRPCError({ code: 'FORBIDDEN', message: 'no' });

    expect(mapMarketError(decided, 'fallback')).toBe(decided);
  });

  it('falls back for something that is not an error', () => {
    expect(mapMarketError('boom', 'Failed to publish').message).toBe('Failed to publish');
  });
});

describe('isMarketNotFound', () => {
  it('is true only for a 404', () => {
    expect(isMarketNotFound(apiError(404))).toBe(true);
    for (const status of [401, 403, 429, 500, 503]) {
      expect(isMarketNotFound(apiError(status))).toBe(false);
    }
    expect(isMarketNotFound(new Error('network'))).toBe(false);
    expect(isMarketNotFound(undefined)).toBe(false);
  });
});
