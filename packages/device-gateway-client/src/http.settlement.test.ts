import { afterEach, describe, expect, it, vi } from 'vitest';

import { transport } from './__tests__/httpFixtures';
import { DeviceTransportErrorCode } from './deviceTransportError';
import type { GatewayHttpClientOptions } from './http';
import { GatewayHttpClient } from './http';

const client = (settleDispatch?: GatewayHttpClientOptions['settleDispatch']) =>
  new GatewayHttpClient({
    ...transport,
    gatewayUrl: 'https://gateway.invalid',
    serviceToken: 'TEST-ONLY',
    settleDispatch,
  });
const invoke = (subject: GatewayHttpClient) =>
  subject.invokeRpc({ userId: 'user-1' }, { method: 'read' });
const fetchReply = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const { intent } = JSON.parse(String(options.body));
      return new Response(
        JSON.stringify({
          tenantId: 'tenant-test',
          sourceAcceptedVersion: 7,
          attemptId: intent.attemptId,
          dispatchBinding: {
            connectionId: 'actual',
            connectionGeneration: 1,
            authorizationId: 'authorization',
          },
          outcome: 'completed',
          result: { success: true, data: 42 },
        }),
        { headers: { 'X-LobeHub-Gateway-Tenancy': '1', 'X-LobeHub-Tenant-Id': 'tenant-test' } },
      );
    }),
  );
afterEach(() => vi.unstubAllGlobals());
describe('trusted synchronous settlement barrier', () => {
  it('refuses to send when the Work handler is missing', async () => {
    fetchReply();
    await expect(invoke(client())).rejects.toThrow('TENANT_EXECUTION_VERSION_REQUIRED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('awaits settlement and does not return business success if settlement rejects', async () => {
    fetchReply();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let returned = false;
    const pending = invoke(
      client(async () => {
        entered();
        await gate;
      }),
    ).then((result) => {
      returned = true;
      return result;
    });
    await ready;
    expect(returned).toBe(false);
    release();
    expect(await pending).toMatchObject({ success: true, data: 42 });
    await expect(
      invoke(
        client(async () => {
          throw new Error('SETTLEMENT_REJECTED');
        }),
      ),
    ).rejects.toMatchObject({ cause: new Error('SETTLEMENT_REJECTED') });
  });
  it('keeps a post-HTTP settlement connection error unknown, distinct from a pre-HTTP connection failure', async () => {
    fetchReply();
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const subject = client(async () => {
      throw cause;
    });
    const call = () =>
      subject.executeToolCall(
        { userId: 'user-1' },
        { identifier: 'builtin', apiName: 'readFile', arguments: '{}' },
      );
    const result = await call();
    expect(result).toMatchObject({ success: false, executionUnknown: true });
    expect(result.content).not.toMatch(/never ran|Retry once/);
    expect(result.content).toContain('do NOT');
    await expect(invoke(subject)).rejects.toMatchObject({ cause });
    vi.mocked(fetch).mockRejectedValue(cause);
    const beforeSend = await call();
    expect(beforeSend.executionUnknown).not.toBe(true);
    expect(beforeSend.error).toContain(DeviceTransportErrorCode.GatewayUnreachable);
    expect(beforeSend.content).toContain('never ran');
  });
});
