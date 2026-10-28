import { EventEmitter } from 'node:events';

import type { GatewayClient, ToolCallRequestMessage } from '@lobechat/device-gateway-client';
import { describe, expect, it, vi } from 'vitest';

import { executeToolCall } from '../tools';
import type { GatewayHandlerContext } from './gatewayHandlers';
import { bindGatewayClientHandlers } from './gatewayHandlers';

vi.mock('../tools', () => ({
  executeToolCall: vi.fn().mockResolvedValue({ content: 'done', success: true }),
}));

const command = (current: () => boolean): ToolCallRequestMessage => ({
  type: 'tool_call_request',
  attemptId: 'original-attempt',
  executionSignal: new AbortController().signal,
  isExecutionCurrent: current,
  requestId: 'same-request',
  toolCall: { apiName: 'writeFile', arguments: '{}', identifier: 'local' },
});
const setup = (run: GatewayHandlerContext['maintenance']['run']) => {
  const client = Object.assign(new EventEmitter(), { sendToolCallResponse: vi.fn() });
  bindGatewayClientHandlers(client as GatewayClient, {
    deps: {},
    error: vi.fn(),
    info: vi.fn(),
    recordRequest: vi.fn(),
    isDaemonChild: false,
    getAuth: () => ({
      serverUrl: 'https://example.test/orgs/a',
      token: 'test',
      tokenType: 'jwt',
      userId: 'same-sub',
    }),
    maintenance: { run } as GatewayHandlerContext['maintenance'],
  });
  return client;
};

describe('CLI actual dequeue execution boundary', () => {
  it('does not start a tool after authority changed while queued', async () => {
    vi.mocked(executeToolCall).mockClear();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = setup(async (run) => {
      await wait;
      return run();
    });
    let current = true;
    const pending = (
      client.listeners('tool_call_request')[0] as (request: ToolCallRequestMessage) => Promise<void>
    )(command(() => current));
    current = false;
    release();
    await pending;
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(client.sendToolCallResponse).not.toHaveBeenCalled();
  });

  it('passes cancellation and echoes the attempt actually executed', async () => {
    const client = setup(async (run) => run());
    const request = command(() => true);
    await (
      client.listeners('tool_call_request')[0] as (request: ToolCallRequestMessage) => Promise<void>
    )(request);
    expect(vi.mocked(executeToolCall).mock.calls.at(-1)?.[4]).toBe(request.executionSignal);
    expect(client.sendToolCallResponse).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: request.attemptId, requestId: request.requestId }),
    );
  });
});
