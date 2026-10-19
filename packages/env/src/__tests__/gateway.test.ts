// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertDistinctGatewayServiceTokens, getGatewayConfig } from '../gateway';

describe('DEVICE_GATEWAY_PUBLIC_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([undefined, '', '   '])('treats %j as not configured', (value) => {
    vi.stubEnv('DEVICE_GATEWAY_PUBLIC_URL', value);

    expect(getGatewayConfig().DEVICE_GATEWAY_PUBLIC_URL).toBeUndefined();
  });

  it.each([
    ['https://device-gateway.example.com', 'https://device-gateway.example.com'],
    ['http://192.168.1.10:8788', 'http://192.168.1.10:8788'],
    ['https://example.com/device-gateway', 'https://example.com/device-gateway'],
    ['https://device-gateway.example.com/', 'https://device-gateway.example.com'],
  ])('accepts the http(s) base URL %j', (value, expected) => {
    vi.stubEnv('DEVICE_GATEWAY_PUBLIC_URL', value);

    expect(getGatewayConfig().DEVICE_GATEWAY_PUBLIC_URL).toBe(expected);
  });

  it.each([
    'not a url',
    'ftp://device-gateway.example.com',
    'https://user:synthetic-secret@device-gateway.example.com',
    'https://device-gateway.example.com/?token=synthetic-secret',
    'https://device-gateway.example.com/#synthetic-secret',
  ])('fails validation for the non-empty invalid value %j', (value) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('DEVICE_GATEWAY_PUBLIC_URL', value);

    expect(() => getGatewayConfig()).toThrow('Invalid environment variables');
    const report = JSON.stringify(consoleError.mock.calls);
    expect(report).toContain('DEVICE_GATEWAY_PUBLIC_URL');
    expect(report).not.toContain('synthetic-secret');
  });
});

describe('assertDistinctGatewayServiceTokens', () => {
  it('accepts different agent and device tokens', () => {
    expect(() =>
      assertDistinctGatewayServiceTokens({
        AGENT_GATEWAY_SERVICE_TOKEN: 'agent-token',
        DEVICE_GATEWAY_SERVICE_TOKEN: 'device-token',
      }),
    ).not.toThrow();
  });

  it.each([
    [{}],
    [{ AGENT_GATEWAY_SERVICE_TOKEN: 'only-agent' }],
    [{ DEVICE_GATEWAY_SERVICE_TOKEN: 'only-device' }],
    [{ AGENT_GATEWAY_SERVICE_TOKEN: '', DEVICE_GATEWAY_SERVICE_TOKEN: '' }],
  ])('does not complain when a token is unset or blank: %j', (env) => {
    expect(() => assertDistinctGatewayServiceTokens(env)).not.toThrow();
  });

  it('names both variables and the consequence when the tokens are equal, without echoing the value', () => {
    const shared = 'synthetic-shared-secret';
    let message = '';
    try {
      assertDistinctGatewayServiceTokens({
        AGENT_GATEWAY_SERVICE_TOKEN: shared,
        DEVICE_GATEWAY_SERVICE_TOKEN: shared,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('AGENT_GATEWAY_SERVICE_TOKEN');
    expect(message).toContain('DEVICE_GATEWAY_SERVICE_TOKEN');
    expect(message).toContain('503');
    expect(message).not.toContain(shared);
  });
});
