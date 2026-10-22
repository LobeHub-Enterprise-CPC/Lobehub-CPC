// @vitest-environment node
import net from 'node:net';

import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discoverConnectorOAuth,
  exchangeConnectorCode,
  refreshConnectorToken,
  registerDynamicClient,
} from './oauth';

/**
 * The MCP server URL is typed in by the user, and the authorization-server
 * metadata it advertises is controlled by that server. Neither may steer the
 * app server into private or metadata addresses.
 */
const connectTargets: string[] = [];

beforeEach(() => {
  connectTargets.length = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    // net.connect() hands the normalized `[options, cb]` pair through as one array.
    const [first] = Array.isArray(args[0]) ? args[0] : args;
    connectTargets.push(`${first?.host}:${first?.port}`);
    this.destroy(new Error('network disabled in test'));
    return this;
  } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const privateMetadata = {
  authorization_endpoint: 'https://auth.example.com/authorize',
  issuer: 'http://10.0.0.8',
  registration_endpoint: 'http://10.0.0.8/register',
  response_types_supported: ['code'],
  token_endpoint: 'http://169.254.169.254/token',
} as AuthorizationServerMetadata;

describe('connector OAuth outbound requests', () => {
  it.each(['http://169.254.169.254/mcp', 'http://127.0.0.1:8080/mcp', 'http://192.168.1.10/mcp'])(
    'does not probe or discover against %s',
    async (url) => {
      await expect(discoverConnectorOAuth(url)).rejects.toBeDefined();

      expect(connectTargets).toEqual([]);
    },
  );

  it('does not register a client at a private registration endpoint', async () => {
    await expect(
      registerDynamicClient({
        authorizationServerUrl: 'http://10.0.0.8',
        metadata: privateMetadata,
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });

  it('does not send the authorization code to a private token endpoint', async () => {
    await expect(
      exchangeConnectorCode({
        authorizationCode: 'code',
        authorizationServerUrl: 'http://10.0.0.8',
        clientInformation: { client_id: 'cid', client_secret: 'secret' } as any,
        codeVerifier: 'verifier',
        metadata: privateMetadata,
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });

  it('does not send the refresh token to a private token endpoint', async () => {
    await expect(
      refreshConnectorToken({
        authorizationServerUrl: 'http://10.0.0.8',
        clientInformation: { client_id: 'cid', client_secret: 'secret' } as any,
        metadata: privateMetadata,
        refreshToken: 'refresh-token',
      }),
    ).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });
});
