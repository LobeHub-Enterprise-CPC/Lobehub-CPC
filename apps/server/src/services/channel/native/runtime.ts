import type { AgentRuntimeHost, AgentState } from '@lobechat/agent-runtime';

import { ChannelNativeModel } from '@/database/models/channelNative';
import type { RuntimeExecutorContext } from '@/server/modules/AgentRuntime/context';

import { channelArtifactCapability } from '../artifact';
import { runChannelToolAttempt } from './effects';

/** Delivery policy around the standard transports; LLM and tool semantics remain standard. */
export function withChannelDelivery(ctx: RuntimeExecutorContext, host: AgentRuntimeHost) {
  const storeFor = (state: AgentState) =>
    state.host?.channel && ctx.userId
      ? new ChannelNativeModel(ctx.serverDB, ctx.userId, state.host.channel)
      : undefined;
  const llm = host.transports.llm;
  if (llm?.runAttempt) {
    const runAttempt = llm.runAttempt.bind(llm);
    llm.runAttempt = async (input) => {
      const store = storeFor(input.state);
      if (!store) return runAttempt(input);
      const id = `${ctx.operationId}:model:${ctx.stepIndex}:${input.attempt}`;
      await store.beginEffect(ctx.operationId, id, 'model');
      try {
        return await runAttempt(input);
      } finally {
        await store.settleEffect(id);
      }
    };
  }
  if (llm?.stream) {
    const stream = llm.stream.bind(llm);
    llm.stream = async (...args) => {
      const state = await ctx.loadAgentState?.(ctx.operationId);
      const store = state && storeFor(state);
      if (!store) return stream(...args);
      const id = `${ctx.operationId}:compression:${ctx.stepIndex}`;
      await store.beginEffect(ctx.operationId, id, 'model');
      try {
        return await stream(...args);
      } finally {
        await store.settleEffect(id);
      }
    };
  }
  const tools = host.transports.tools;
  if (tools) {
    const run = tools.run.bind(tools);
    tools.run = async (call, context) => {
      const store = storeFor(context.state);
      if (!store || call.identifier !== 'channel-artifact') return run(call, context);
      const capability = await channelArtifactCapability(
        ctx.serverDB,
        ctx.userId!,
        (await store.load()).run,
      );
      return {
        attempts: 1,
        result: await runChannelToolAttempt(
          ctx,
          context.state,
          call.id,
          1,
          async () => (await capability.toolTransport!.run(call, context)).result,
        ),
      };
    };
  }
  return host;
}
