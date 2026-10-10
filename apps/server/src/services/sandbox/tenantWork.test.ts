import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';
import { TenantLiveResources } from '@/server/modules/Tenant/liveResources';

import { callTenantSandboxTool } from './tenantWork';

const state = vi.hoisted(() => ({
  begin: vi.fn(async () => {}),
  confirm: vi.fn(async () => {}),
  identify: vi.fn(async () => {}),
  registry: undefined as any,
}));
vi.mock('@/server/modules/Tenant/externalWork', () => ({
  beginExternalTenantWork: state.begin,
  confirmExternalTenantWork: state.confirm,
  identifyExternalTenantWork: state.identify,
}));
vi.mock('@/server/modules/Tenant/liveResources', async (original) => ({
  ...(await original<object>()),
  getTenantLiveResources: () => state.registry,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('tenant sandbox completion receipts', () => {
  it('records foreground work before a transport failure and retains the unknown job', async () => {
    const provider = {
      kind: 'onlyboxes',
      callTool: vi.fn(async () => {
        expect(state.begin).toHaveBeenCalled();
        throw new Error('response lost');
      }),
    };
    await runWithTenantScope(
      { tenantId: 'foreground', slug: 't', session: {} } as TenantScope,
      async () => {
        await expect(
          callTenantSandboxTool(provider as any, 'runCommand', { command: 'sleep 60' }),
        ).rejects.toThrow('response lost');
        expect(state.confirm).not.toHaveBeenCalled();
      },
    );
  });
  it('retains a lookup handle when a foreground response has no terminal exit code', async () => {
    state.registry = new TenantLiveResources(async () => {}, 60000);
    const provider = {
      kind: 'onlyboxes',
      callTool: vi.fn(async (name: string) =>
        name === 'runCommand'
          ? { success: false, result: { commandId: 'foreground-unknown' } }
          : { success: true, result: { running: false } },
      ),
    };
    await runWithTenantScope(
      { tenantId: 'foreground-handle', slug: 't', session: {} } as TenantScope,
      async () => {
        await callTenantSandboxTool(provider as any, 'runCommand', { command: 'sleep' });
        expect(state.identify).toHaveBeenCalledWith(
          'sandbox',
          expect.any(String),
          expect.stringContaining('foreground-unknown'),
        );
        expect(state.confirm).not.toHaveBeenCalled();
        await state.registry.suspend('foreground-handle', new TenantGateError('TENANT_FROZEN'));
        expect(state.confirm).toHaveBeenCalled();
      },
    );
  });
  it('bounds cancellation polling and retries observation without repeating accepted cancellation', async () => {
    vi.useFakeTimers();
    state.registry = new TenantLiveResources(async () => {}, 60000);
    let ended = false;
    const provider = {
      kind: 'onlyboxes',
      callTool: vi.fn(async (name: string) => {
        if (name === 'runCommand') return { success: true, result: { commandId: 'bounded' } };
        if (name === 'killCommand') return { success: true, result: {} };
        return { success: true, result: { running: !ended } };
      }),
    };
    await runWithTenantScope(
      { tenantId: 'bounded', slug: 't', session: {} } as TenantScope,
      async () => {
        await callTenantSandboxTool(provider as any, 'runCommand', {
          command: 'sleep',
          background: true,
        });
        const stopping = state.registry.suspend('bounded', new TenantGateError('TENANT_FROZEN'));
        const rejected = expect(stopping).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(10001);
        await rejected;
        const calls = provider.callTool.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10000);
        expect(provider.callTool.mock.calls.length).toBe(calls);
        ended = true;
        await state.registry.suspend('bounded', new TenantGateError('TENANT_FROZEN'));
        expect(
          provider.callTool.mock.calls.filter(([name]) => name === 'killCommand'),
        ).toHaveLength(1);
      },
    );
  });
  it('waits for a terminal observation after cancellation is accepted', async () => {
    state.registry = new TenantLiveResources(async () => {}, 60000);
    let terminal = false;
    const provider = {
      callTool: vi.fn(async (name: string) => {
        if (name === 'runCommand') {
          expect(state.begin).toHaveBeenCalled();
          return { success: true, result: { commandId: 'remote' } };
        }
        if (name === 'killCommand') return { success: true, result: {} };
        return { success: true, result: { running: !terminal } };
      }),
    };
    await runWithTenantScope({ tenantId: 't', slug: 't', session: {} } as TenantScope, async () => {
      await callTenantSandboxTool(provider as any, 'runCommand', {
        background: true,
        command: 'sleep',
      });
      let complete = false;
      const stop = state.registry.suspend('t', new TenantGateError('TENANT_FROZEN')).then(() => {
        complete = true;
      });
      await vi.waitFor(() =>
        expect(provider.callTool).toHaveBeenCalledWith('killCommand', { commandId: 'remote' }),
      );
      expect(complete).toBe(false);
      expect(state.confirm).not.toHaveBeenCalled();
      terminal = true;
      await stop;
      expect(state.confirm).toHaveBeenCalledTimes(1);
    });
  });
});
