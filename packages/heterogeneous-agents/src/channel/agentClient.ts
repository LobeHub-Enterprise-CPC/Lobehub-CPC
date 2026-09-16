import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildHeteroSpawnArgs,
  type ChannelRuntime,
  type HeterogeneousProviderConfig,
} from '@lobechat/types';

import { resolveHeterogeneousAgentCommand } from '../config';
import { ProcessTreeTracker } from '../process/ProcessTreeTracker';
import { buildHeterogeneousPrompt } from '../protocol/promptEngine';
import { resolveCliSpawnPlan } from '../spawn/cliSpawn';
import { spawnAgent, type SpawnAgentHandle, type SpawnAgentOptions } from '../spawn/spawnAgent';
import type { CodexChannelSnapshot, CodexChannelStart } from './host';
import { CHANNEL_INSTRUCTIONS, channelInput } from './input';

export type ChannelAgentRuntime = Exclude<ChannelRuntime, 'native'>;
export type ChannelLaunch = Pick<
  SpawnAgentOptions,
  'command' | 'env' | 'extraArgs' | 'inheritEnv'
> & {
  bindingKey?: string;
  cleanup?: () => Promise<void>;
};
export type PrepareChannelLaunch = (input: CodexChannelStart) => Promise<ChannelLaunch>;
export type ProbeChannelAgent = typeof ChannelAgentClient.probe;

export class ChannelBindingChangedError extends Error {
  constructor() {
    super(
      'Agent provider binding changed or is unknown; rebuild the Channel session before retrying',
    );
  }
}

/** Use the same selectors and CLI configuration as standalone Agent execution. */
export const prepareChannelLaunch: PrepareChannelLaunch = async (input) => {
  const provider = input.provider ?? {
    type: input.runtime ?? 'codex',
    model: input.model,
  };
  if (provider.type !== (input.runtime ?? 'codex')) throw new Error('Agent runtime changed');
  if (provider.authMode === 'api')
    throw new Error('API execution requires the Desktop provider binding host');
  return {
    command: provider.command,
    env: provider.env,
    extraArgs: buildHeteroSpawnArgs(provider),
  };
};

/** Channel contributes input and observes output; the shared runtime owns tools and permissions. */
export class ChannelAgentClient {
  private handle?: SpawnAgentHandle;
  private exited = false;
  private closed = false;
  private starting?: Promise<SpawnAgentHandle>;
  private timer?: ReturnType<typeof setInterval>;
  private termination?: Promise<boolean>;
  private readonly processTree = new ProcessTreeTracker(() =>
    this.handle
      ? { pid: this.handle.pid, exitCode: this.exited ? 0 : null, signalCode: null }
      : undefined,
  );

  constructor(private readonly prepare: PrepareChannelLaunch = prepareChannelLaunch) {}

  static async probe(
    cwd: string,
    runtime: ChannelAgentRuntime,
    provider?: HeterogeneousProviderConfig,
    inheritEnv = true,
  ) {
    const command = resolveHeterogeneousAgentCommand(runtime, provider?.command);
    const env = { ...(inheritEnv ? process.env : {}), ...provider?.env } as NodeJS.ProcessEnv;
    // Resolve the CLI the way spawnAgent launches it. On Windows an npm-installed CLI
    // is a `.cmd` shim, which execFile refuses to run without a shell since Node's
    // CVE-2024-27980 fix (`spawn EINVAL`); the plan unwraps it to the real executable.
    const plan = await resolveCliSpawnPlan(command, ['--version'], env);
    const { stdout } = await promisify(execFile)(plan.command, plan.args, {
      cwd,
      env,
      timeout: 5000,
      windowsHide: true,
    });
    return stdout.trim();
  }

  closeAndConfirmTermination(): Promise<boolean> {
    this.closed = true;
    this.termination ??= (async () => {
      // A stop racing asynchronous CLI setup must also stop the process it creates.
      if (this.starting) await this.starting.catch(() => {});
      return this.processTree.terminate(() => {
        clearInterval(this.timer);
        // A retained background handle may outlive its root PID/process group identity.
        // Signal observed descendants by identity instead of reusing a dead root's group.
        if (!this.exited) this.handle?.kill('SIGTERM');
      });
    })();
    return this.termination;
  }

  async run(
    input: CodexChannelStart,
    snapshot: CodexChannelSnapshot,
    persist: () => Promise<void>,
  ) {
    const launch = await this.prepare(input);
    try {
      if (this.closed) throw new Error('Run stopped before submission');
      snapshot.bindingKey = launch.bindingKey ?? 'subscription';
      // Resumed native sessions retain the protocol from their first delivery.
      // Rebuilt sessions have no sessionId and need the introduction again.
      const prompt = [
        !input.sessionId && CHANNEL_INSTRUCTIONS,
        input.systemRole,
        channelInput({
          ...input.manifest,
          messages: input.manifest.messages.map((message) => ({
            ...message,
            content: [
              message.content,
              input.attachmentContext?.find((item) => item.messageId === message.id)?.content,
            ]
              .filter(Boolean)
              .join('\n\n'),
          })),
        }),
      ]
        .filter(Boolean)
        .join('\n\n');
      snapshot.input = {
        prompt,
        systemRole: input.systemRole || '',
        runtime: input.runtime ?? 'codex',
        resumedSessionId: input.sessionId || null,
      };
      await persist();
      if (this.closed) throw new Error('Run stopped before submission');
      this.starting = spawnAgent({
        agentType: input.runtime ?? 'codex',
        command: launch.command,
        cwd: input.cwd,
        env: launch.env,
        inheritEnv: launch.inheritEnv,
        extraArgs: launch.extraArgs,
        operationId: input.runId,
        prompt: input.attachmentContext?.length
          ? buildHeterogeneousPrompt({
              prompt,
              imageList: input.attachmentContext.flatMap((item) => item.imageList),
            })
          : prompt,
        resumeSessionId: input.sessionId || undefined,
      }).then((handle) => {
        this.handle = handle;
        void handle.exit.then(
          () => {
            this.exited = true;
          },
          () => {
            this.exited = true;
          },
        );
        return handle;
      });
      const handle = await this.starting;
      // Drain stderr without publishing native config/credentials in Channel errors.
      handle.stderr.resume();
      this.timer = setInterval(() => void this.processTree.track(), 50);
      await this.processTree.track();
      if (this.closed) throw new Error('Run stopped during submission');
      snapshot.status = 'running';
      snapshot.activity = 'running';
      const tools = new Set<string>();
      const replies = new Map<number, string>();
      let failed = false;
      let observedWork = false;
      for await (const event of handle.events) {
        const data = event.data;
        if (this.closed) break;
        if (handle.sessionId) snapshot.sessionId = handle.sessionId;
        if (!data?.subagent) {
          if (event.type === 'stream_start' && data.sessionId) snapshot.sessionId = data.sessionId;
          if (event.type === 'stream_chunk' && data.chunkType === 'text' && data.content) {
            replies.set(event.stepIndex, (replies.get(event.stepIndex) || '') + data.content);
            snapshot.activity = 'typing';
            observedWork = true;
          }
          if (event.type === 'error') failed = true;
        }
        if (event.type === 'tool_start') {
          observedWork = true;
          const toolId = data.toolCallId ?? data.toolCalling?.id;
          if (toolId) tools.add(`${data.subagent?.parentToolCallId || 'main'}:${toolId}`);
          snapshot.activity = 'running';
        }
        snapshot.toolCalls = tools.size;
        // Observed counts are telemetry, not a Channel-imposed execution budget.
        if (snapshot.sessionId && observedWork) {
          snapshot.turnId = input.runId;
          snapshot.acceptance = 'accepted';
        }
        await persist();
      }
      const exit = await handle.exit;
      if (this.closed) throw new Error('Agent execution interrupted');
      if (failed || exit.code !== 0)
        throw new Error('Agent execution failed; inspect the native session');
      snapshot.sessionId = handle.sessionId || snapshot.sessionId;
      snapshot.content = [...replies.values()].filter(Boolean).join('\n\n');
      if (!snapshot.sessionId || !snapshot.content)
        throw new Error('Agent did not return a reply and session identity');
      snapshot.turnId = input.runId;
      snapshot.acceptance = 'accepted';
      snapshot.runtimeCompleted = true;
      snapshot.physicalStopped = this.exited && (await this.processTree.isStopped());
    } finally {
      clearInterval(this.timer);
      // A completed native turn may deliberately leave a dev server or background task.
      // Only an explicit stop or failed execution terminates the remaining process tree.
      if (!snapshot.runtimeCompleted) await this.closeAndConfirmTermination();
      await launch.cleanup?.();
    }
  }
}
