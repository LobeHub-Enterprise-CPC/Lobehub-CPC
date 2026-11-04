import { describe, expect, it } from 'vitest';

import { gatewayIdentityFailure } from './identity';

describe('gatewayIdentityFailure', () => {
  // Electron's net.fetch (the desktop's ticket requests) reports transport
  // failures as Chromium net::ERR_* errors. Being offline is temporary: giving up
  // on it leaves the device disconnected until the app restarts.
  it.each([
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_TIMED_OUT',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_CERT_DATE_INVALID',
  ])('retries Chromium transport failure %s', (message) => {
    expect(gatewayIdentityFailure(new Error(message))).toEqual({
      code: 'GATEWAY_AUTHORITY_UNAVAILABLE',
      retryable: true,
    });
  });

  // A request that can never be sent as configured does not get better by retrying.
  it.each(['net::ERR_INVALID_URL', 'net::ERR_UNSAFE_REDIRECT', 'net::ERR_DISALLOWED_URL_SCHEME'])(
    'stops on Chromium configuration failure %s',
    (message) => {
      expect(gatewayIdentityFailure(new Error(message))).toEqual({
        code: 'GATEWAY_TENANCY_UNSUPPORTED',
        retryable: false,
      });
    },
  );

  it('still stops on a protocol denial and an unexplained failure', () => {
    expect(gatewayIdentityFailure(new Error('UNAUTHORIZED'))).toEqual({
      code: 'UNAUTHORIZED',
      retryable: false,
    });
    expect(gatewayIdentityFailure(new Error('something else'))).toEqual({
      code: 'SOURCE_UNVERIFIABLE',
      retryable: false,
    });
  });
});
