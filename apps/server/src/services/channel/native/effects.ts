import type { AgentState } from '@lobechat/agent-runtime';

import { ChannelNativeModel } from '@/database/models/channelNative';
import type { RuntimeExecutorContext } from '@/server/modules/AgentRuntime/context';
import type { ToolExecutionResult } from '@/server/services/toolExecution/types';

/** Reserve each actual attempt; transport timeouts never prove physical completion. */
export async function runChannelToolAttempt<T extends ToolExecutionResult>(
  ctx: RuntimeExecutorContext,
  state: AgentState,
  toolCallId: string,
  attempt: number,
  execute: () => Promise<T>,
): Promise<T> {
  if (!state.host?.channel || !ctx.userId) return execute();
  const store = new ChannelNativeModel(ctx.serverDB, ctx.userId, state.host.channel);
  const id = `${ctx.operationId}:tool:${toolCallId}:attempt:${attempt}`;
  await store.beginEffect(ctx.operationId, id, 'tool');
  const result = await execute();
  // A deferred tool transfers execution to the standard async operation tree;
  // its child effects and the parent's waiting state retain the writer.
  if (!result.executionUnknown) await store.settleEffect(id);
  return result;
}
