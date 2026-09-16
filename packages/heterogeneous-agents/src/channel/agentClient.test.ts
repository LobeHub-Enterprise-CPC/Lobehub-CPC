import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';

import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliSpawnPlan } from '../spawn/cliSpawn';
import { spawnAgent } from '../spawn/spawnAgent';
import { ChannelAgentClient, prepareChannelLaunch } from './agentClient';
import type { CodexChannelSnapshot, CodexChannelStart } from './host';
import { CHANNEL_INSTRUCTIONS } from './input';

vi.mock('../spawn/spawnAgent', () => ({ spawnAgent: vi.fn() }));
vi.mock('../spawn/cliSpawn', () => ({ resolveCliSpawnPlan: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: vi.fn(),
}));
vi.mock('../process/ProcessTreeTracker', () => ({
  ProcessTreeTracker: class {
    async track() {}
    async isStopped() {
      return false;
    }
    async terminate(close: () => void) {
      close();
      return true;
    }
  },
}));

const input: CodexChannelStart = {
  cwd: '/ordinary-directory',
  fence: 7,
  model: '',
  ownerId: 'owner',
  runId: 'run',
  runtime: 'amp',
  sessionId: 'native-session',
  systemRole: 'Keep the original role',
  manifest: {
    self: { memberId: 'member-amp', name: 'Amp Reviewer' },
    threadRootSequence: 4,
    cutoffSequence: 9,
    messages: [
      {
        id: 'm9',
        sequence: 9,
        threadId: 'branch',
        author: { id: 'owner', name: 'Owner', type: 'human' },
        content: 'Run the tests',
      },
    ],
    requestMessageId: 'm9',
    sessionGeneration: 1,
    source: 'incremental',
    threadId: 'branch',
  },
};
const receipt = (): CodexChannelSnapshot => ({
  cwd: input.cwd,
  fence: 7,
  inputHash: 'hash',
  runId: 'run',
  acceptance: 'pending',
  physicalStopped: false,
  status: 'starting',
});
const event = (type: string, data: unknown, stepIndex = 0) =>
  ({
    type,
    data,
    stepIndex,
    operationId: 'run',
    timestamp: 1,
  }) as AgentStreamEvent;
function handle(events: AgentStreamEvent[]) {
  return {
    async *events() {
      yield* events;
    },
    exit: Promise.resolve({ code: 0, signal: null }),
    kill: vi.fn(),
    pid: undefined,
    sessionId: 'native-session',
    stderr: new PassThrough(),
  };
}
beforeEach(() => vi.clearAllMocks());

describe('Channel uses the standalone Agent runtime', () => {
  it.each(['codex', 'amp', 'grok-build', 'claude-code', 'pi'] as const)(
    'preserves %s tools, configuration and delta session',
    async (runtime) => {
      const h = handle([
        event('stream_start', { sessionId: 'native-session' }),
        ...Array.from({ length: 65 }, (_, i) => event('tool_start', { toolCallId: `tool-${i}` })),
        event('stream_chunk', {
          chunkType: 'text',
          content: 'private child output',
          subagent: { parentToolCallId: 'child' },
        }),
        event('stream_chunk', { chunkType: 'text', content: 'Tests ' }, 2),
        event('stream_chunk', { chunkType: 'text', content: 'passed' }, 2),
        event('agent_runtime_end', {}),
      ]);
      vi.mocked(spawnAgent).mockResolvedValue({ ...h, events: h.events() });
      const snapshot = receipt();
      const request = {
        ...input,
        runtime,
        provider: {
          type: runtime,
          command: '/custom/agent',
          args: ['--custom-setting'],
          env: { PRIVATE_VALUE: 'secret' },
        },
      };
      const client = new ChannelAgentClient();
      await client.run(request, snapshot, vi.fn().mockResolvedValue(undefined));
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: runtime,
          command: '/custom/agent',
          extraArgs: ['--custom-setting'],
          env: { PRIVATE_VALUE: 'secret' },
          resumeSessionId: 'native-session',
          cwd: input.cwd,
        }),
      );
      const prompt = vi.mocked(spawnAgent).mock.calls[0][0].prompt as string;
      expect(prompt).toContain('"contextMode":"delta"');
      expect(prompt).toContain('Keep the original role');
      expect(prompt).not.toContain(CHANNEL_INSTRUCTIONS);
      expect(JSON.parse(prompt.slice(prompt.indexOf('{')))).toEqual({
        deliveryInstruction: expect.stringContaining('ordinary Channel message'),
        self: { memberId: 'member-amp', name: 'Amp Reviewer' },
        threadId: 'branch',
        threadRootSequence: 4,
        cutoffSequence: 9,
        contextMode: 'delta',
        activeRequestMessageId: 'm9',
        newMessages: input.manifest.messages,
      });
      expect(snapshot.input?.prompt).toBe(prompt);
      expect(prompt).not.toContain('Do not call tools');
      expect(snapshot.content).toBe('Tests passed');
      expect(snapshot.toolCalls).toBe(65);
      expect(snapshot.acceptance).toBe('accepted');
      expect(snapshot.runtimeCompleted).toBe(true);
      expect(h.kill).not.toHaveBeenCalled();
      expect(JSON.stringify(snapshot)).not.toContain('secret');
      await client.closeAndConfirmTermination();
      expect(h.kill).not.toHaveBeenCalled(); // Never signal a dead root's potentially reused group.
    },
  );

  it.each(['codex', 'amp', 'grok-build', 'claude-code', 'pi'] as const)(
    'introduces the Channel protocol in new and rebuilt %s sessions',
    async (runtime) => {
      for (const sessionGeneration of [1, 2]) {
        const h = handle([
          event('stream_start', { sessionId: `new-session-${sessionGeneration}` }),
          event('stream_chunk', { chunkType: 'text', content: 'Tests passed' }),
          event('agent_runtime_end', {}),
        ]);
        vi.mocked(spawnAgent).mockResolvedValue({ ...h, events: h.events() });
        const request: CodexChannelStart = {
          ...input,
          runtime,
          sessionId: undefined,
          systemRole: '',
          manifest: { ...input.manifest, source: 'reconstructed', sessionGeneration },
        };
        const snapshot = receipt();
        await new ChannelAgentClient().run(request, snapshot, async () => {});
        const options = vi.mocked(spawnAgent).mock.lastCall![0];
        const prompt = options.prompt as string;
        expect(options.resumeSessionId).toBeUndefined();
        expect(prompt.startsWith(`${CHANNEL_INSTRUCTIONS}\n\n`)).toBe(true);
        expect(prompt.split(CHANNEL_INSTRUCTIONS)).toHaveLength(2);
        expect(JSON.parse(prompt.slice(prompt.indexOf('{')))).toEqual({
          deliveryInstruction: expect.stringContaining('ordinary Channel message'),
          self: { memberId: 'member-amp', name: 'Amp Reviewer' },
          threadId: 'branch',
          threadRootSequence: 4,
          cutoffSequence: 9,
          contextMode: 'snapshot',
          activeRequestMessageId: 'm9',
          newMessages: input.manifest.messages,
        });
        expect(snapshot.input?.prompt).toBe(prompt);
      }
    },
  );

  it.each(['codex', 'amp', 'grok-build', 'claude-code', 'pi'] as const)(
    'omits the fixed introduction from resumed %s discussion, revision and summary turns',
    async (runtime) => {
      for (const kind of ['discuss', 'revise', 'summarize'] as const) {
        const h = handle([
          event('stream_start', { sessionId: 'native-session' }),
          event('stream_chunk', { chunkType: 'text', content: 'A contribution' }),
        ]);
        vi.mocked(spawnAgent).mockResolvedValue({ ...h, events: h.events() });
        const discussion = {
          id: 'discussion',
          kind,
          round: 3,
          maxRounds: 10,
          ...(kind === 'revise' && { heldDraft: 'Unpublished candidate' }),
        };
        const request: CodexChannelStart = {
          ...input,
          runtime,
          systemRole: '',
          manifest: {
            ...input.manifest,
            discussion,
            messages: kind === 'summarize' ? [] : input.manifest.messages,
          },
        };
        const snapshot = receipt();
        await new ChannelAgentClient().run(request, snapshot, async () => {});
        const options = vi.mocked(spawnAgent).mock.lastCall![0];
        expect(options.resumeSessionId).toBe('native-session');
        expect(options.prompt).not.toContain(CHANNEL_INSTRUCTIONS);
        const wire = JSON.parse(options.prompt as string);
        expect(wire).toMatchObject({
          discussion,
          contextMode: 'delta',
          activeRequestMessageId: input.manifest.requestMessageId,
          newMessages: request.manifest.messages,
        });
        expect(wire.deliveryInstruction).toContain(
          kind === 'revise'
            ? 'HELD:'
            : kind === 'summarize'
              ? 'final synthesis'
              : 'Participate freely',
        );
        expect(snapshot.input?.prompt).toBe(options.prompt);
      }
    },
  );

  it('uses Amp mode and Codex effort/speed selectors rather than the stale membership model', async () => {
    expect(
      await prepareChannelLaunch({ ...input, provider: { type: 'amp', mode: 'high' } }),
    ).toMatchObject({ extraArgs: ['--mode', 'high'] });
    expect(
      await prepareChannelLaunch({
        ...input,
        runtime: 'codex',
        provider: {
          type: 'codex',
          model: 'configured-model',
          effort: 'high',
          speed: 'fast',
        },
      }),
    ).toMatchObject({
      extraArgs: [
        '--model',
        'configured-model',
        '-c',
        'model_reasoning_effort="high"',
        '-c',
        'service_tier="fast"',
      ],
    });
  });

  it.each(['claude-code', 'pi'] as const)(
    'uses the configured %s model instead of the stale membership model',
    async (runtime) => {
      const launch = await prepareChannelLaunch({
        ...input,
        runtime,
        model: 'stale-model',
        provider: { type: runtime, model: 'configured-model', args: ['--verbose'] },
      });
      expect(launch.extraArgs).toEqual(['--verbose', '--model', 'configured-model']);
    },
  );

  it('does not publish an error turn even if the native process exits zero', async () => {
    const h = handle([
      event('stream_chunk', { chunkType: 'text', content: 'unfinished' }),
      event('error', { error: 'failed' }),
    ]);
    vi.mocked(spawnAgent).mockResolvedValue({ ...h, events: h.events() });
    const snapshot = receipt();
    await expect(new ChannelAgentClient().run(input, snapshot, async () => {})).rejects.toThrow(
      'execution failed',
    );
    expect(snapshot.content).toBeUndefined();
  });

  it('stopping during launch preparation never submits a prompt', async () => {
    let release!: () => void;
    const cleanup = vi.fn();
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new ChannelAgentClient(async () => {
      await ready;
      return { cleanup };
    });
    const run = client.run(input, receipt(), async () => {});
    const rejected = expect(run).rejects.toThrow('stopped before submission');
    await client.closeAndConfirmTermination();
    release();
    await rejected;
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('stopping during asynchronous spawn also terminates the newly created handle', async () => {
    const h = handle([]);
    const spawned = {
      ...h,
      exit: new Promise<{ code: number; signal: null }>(() => {}),
      events: h.events(),
    };
    let release!: (value: typeof spawned) => void;
    vi.mocked(spawnAgent).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const client = new ChannelAgentClient();
    const snapshot = receipt();
    const run = client.run(input, snapshot, async () => {});
    const rejected = expect(run).rejects.toThrow('stopped during submission');
    await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalledOnce());
    const stopping = client.closeAndConfirmTermination();
    expect(h.kill).not.toHaveBeenCalled();
    release(spawned);
    await expect(stopping).resolves.toBe(true);
    await rejected;
    expect(h.kill).toHaveBeenCalledWith('SIGTERM');
    expect(snapshot.runtimeCompleted).not.toBe(true);
  });
});

describe('ChannelAgentClient.probe', () => {
  it('runs the version probe through the CLI spawn plan, not the raw .cmd shim', async () => {
    // A Windows npm install exposes the CLI as `claude.cmd`; execFile on that path
    // throws `spawn EINVAL`, so the probe must use the unwrapped executable.
    const shim = String.raw`C:\Users\u\AppData\Roaming\npm\claude.cmd`;
    const exe = String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`;
    vi.mocked(resolveCliSpawnPlan).mockResolvedValue({ args: ['--version'], command: exe });
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, result: unknown) => void;
      callback(null, { stderr: '', stdout: '2.1.0 (Claude Code)\n' });
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    await expect(
      ChannelAgentClient.probe(
        String.raw`C:\work`,
        'claude-code',
        { command: shim, env: { FOO: '1' }, type: 'claude-code' },
        false,
      ),
    ).resolves.toBe('2.1.0 (Claude Code)');

    expect(resolveCliSpawnPlan).toHaveBeenCalledWith(shim, ['--version'], { FOO: '1' });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0].slice(0, 3)).toEqual([
      exe,
      ['--version'],
      expect.objectContaining({ cwd: String.raw`C:\work`, env: { FOO: '1' }, windowsHide: true }),
    ]);
  });
});
