import { randomUUID } from 'node:crypto';

import { currentTenantScope } from '@lobechat/database/tenant';

import {
  beginExternalTenantWork,
  confirmExternalTenantHandle,
  confirmExternalTenantWork,
  identifyExternalTenantWork,
} from '@/server/modules/Tenant/externalWork';
import { getTenantLiveResources } from '@/server/modules/Tenant/liveResources';

import type { SandboxProvider, SandboxServiceOptions } from './types';

const localReceipts = new Map<string, () => void>();

/** Commands need a terminal receipt, including foreground calls whose response may be lost. */
export const callTenantSandboxTool = async (
  provider: SandboxProvider,
  name: string,
  params: Record<string, unknown>,
  context: Partial<Pick<SandboxServiceOptions, 'userId' | 'topicId' | 'sandboxInstanceId'>> = {},
) => {
  const tenantId = currentTenantScope()?.tenantId;
  const handle = (commandId: string) =>
    JSON.stringify([
      tenantId,
      provider.kind,
      context.userId,
      context.topicId,
      context.sandboxInstanceId,
      commandId,
    ]);
  if (!tenantId || !['runCommand', 'executeCode', 'execScript'].includes(name)) {
    const result = await provider.callTool(name, params);
    if (
      tenantId &&
      name === 'getCommandOutput' &&
      typeof params.commandId === 'string' &&
      result.result?.running === false
    ) {
      const key = handle(params.commandId);
      await confirmExternalTenantHandle('sandbox', key);
      localReceipts.get(key)?.();
      localReceipts.delete(key);
    }
    return result;
  }
  const id = randomUUID();
  await beginExternalTenantWork('sandbox', id, provider.getReceiptContext?.(id));
  const result = await provider.callTool(name, params);
  if (
    result.remoteExecution === 'not-started' ||
    (params.background !== true && Number.isInteger(result.result?.exitCode))
  ) {
    await confirmExternalTenantWork('sandbox', id);
    return result;
  }
  const commandId = result.result?.commandId;
  // A failed or lost submit response does not establish that no remote job exists.
  if (typeof commandId !== 'string') return result;
  const key = handle(commandId);
  await identifyExternalTenantWork('sandbox', id, key);
  let release = () => {};
  const terminal = async () => {
    const status = await provider.callTool('getCommandOutput', { commandId });
    if (status.result?.running !== false) return false;
    await confirmExternalTenantWork('sandbox', id);
    localReceipts.delete(key);
    release();
    return true;
  };
  let cancellationAccepted = false;
  release = getTenantLiveResources().bind(tenantId, {
    close: async () => {
      if (await terminal()) return;
      if (!cancellationAccepted) {
        const cancelled = await provider.callTool('killCommand', { commandId });
        if (!cancelled.success) throw new Error('SANDBOX_CANCEL_UNCONFIRMED');
        cancellationAccepted = true;
      }
      // A bounded attempt settles so the registry can retry. Never leave an orphan polling loop.
      for (const delay of [250, 750]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (await terminal()) return;
      }
      throw new Error('SANDBOX_TERMINAL_RECEIPT_PENDING');
    },
  });
  // getCommandOutput can consume incremental output. Never poll it in the
  // background while the tenant is active; normal callers deliver receipts.
  localReceipts.set(key, release);
  return result;
};
