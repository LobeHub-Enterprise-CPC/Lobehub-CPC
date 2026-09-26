import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';

import type { ChannelInputManifest } from '@lobechat/types';
import { CHANNEL_LIMITS } from '@lobechat/types';

import { CodexAppServerClient } from '../codex/CodexAppServerClient';
import type { InitializeResponse, ThreadStartResponse, TurnStartResponse } from '../codex/protocol';
import { ChannelDiscussionClient, type DiscussionRuntime } from './discussionClient';
import { CHANNEL_INSTRUCTIONS, channelInput } from './input';
import { createChannelModelBudget } from './modelBudget';
import { captureChannelWorkspace, type ChannelWorkspaceSnapshot } from './snapshot';

function assertSupportedServer(initialized: InitializeResponse) {
  if (!/\/0\.153\.4(?:\s|$)/.test(initialized.userAgent))
    throw new Error('Channel currently requires the verified Codex app-server 0.153.4 adapter');
}

export interface CodexChannelStart {
  cwd: string;
  fence: number;
  manifest: ChannelInputManifest;
  model: string;
  ownerId: string;
  runId: string;
  runtime?: 'codex' | DiscussionRuntime;
  sessionId?: string | null;
  systemRole?: string;
}

export interface CodexChannelSnapshot {
  acceptance: 'pending' | 'accepted' | 'unknown';
  activity?: 'running' | 'typing';
  approval?: { expiresAt: number; id: string; method: string; request: unknown };
  content?: string;
  cwd: string;
  error?: string;
  evidence?: {
    baseline: ChannelWorkspaceSnapshot;
    final?: ChannelWorkspaceSnapshot;
    commands: unknown[];
  };
  fence: number;
  input?: { prompt: string; systemRole: string; runtime: string; resumedSessionId: string | null };
  inputHash: string;
  modelCalls?: number;
  physicalStopped: boolean;
  runId: string;
  sessionId?: string;
  status:
    | 'starting'
    | 'running'
    | 'awaiting_approval'
    | 'completed'
    | 'stopped'
    | 'execution_unknown'
    | 'failed';
  toolCalls?: number;
  turnId?: string;
}

interface Execution {
  client: CodexAppServerClient | ChannelDiscussionClient;
  done: Promise<void>;
  resolveApproval?: (decision: 'accept' | 'decline') => void;
  snapshot: CodexChannelSnapshot;
  stopping: boolean;
  writes: Promise<void>;
}

/** One dedicated app-server per Run; public input and receipt survive RPC retries. */
export class CodexChannelHost {
  private readonly runs = new Map<string, Execution>();
  private readonly pendingStarts = new Map<string, Promise<CodexChannelSnapshot>>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly journalDirectory: string,
    private readonly commandPath = 'codex',
    private readonly modelCallLimit: number = CHANNEL_LIMITS.modelCalls,
    private readonly toolCallLimit: number = CHANNEL_LIMITS.toolCalls,
  ) {
    if (
      !Number.isInteger(modelCallLimit) ||
      modelCallLimit < 1 ||
      modelCallLimit > CHANNEL_LIMITS.modelCalls
    )
      throw new Error('Channel model call budget may only be reduced');
    if (
      !Number.isInteger(toolCallLimit) ||
      toolCallLimit < 1 ||
      toolCallLimit > CHANNEL_LIMITS.toolCalls
    )
      throw new Error('Channel tool call budget may only be reduced');
  }

  private key(ownerId: string, runId: string) {
    return createHash('sha256')
      .update(JSON.stringify([ownerId, runId]))
      .digest('hex');
  }

  private file(key: string) {
    return path.join(this.journalDirectory, `${key}.json`);
  }

  private persist(key: string, execution: Execution) {
    const data = JSON.stringify(execution.snapshot);
    execution.writes = execution.writes.then(async () => {
      await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file(key)}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.file(key));
      const directory = await open(this.journalDirectory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    return execution.writes;
  }

  async inspect(ownerId: string, runId: string): Promise<CodexChannelSnapshot | null> {
    const key = this.key(ownerId, runId);
    const live = this.runs.get(key);
    if (live) {
      if (live.snapshot.physicalStopped) await live.done;
      await live.writes;
      return structuredClone(live.snapshot);
    }
    try {
      const saved: CodexChannelSnapshot = JSON.parse(await readFile(this.file(key), 'utf8'));
      // Restart cannot certify a previous process tree or re-submit a lost turn.
      if (!saved.physicalStopped)
        return {
          ...saved,
          status: 'execution_unknown',
          acceptance: saved.acceptance === 'pending' ? 'unknown' : saved.acceptance,
        };
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async probe(cwd: string, runtime: 'codex' | DiscussionRuntime = 'codex') {
    if (process.platform === 'win32')
      throw new Error('Channel process termination is not supported on Windows yet');
    const canonicalPath = await realpath(cwd);
    if (runtime !== 'codex') {
      if (!['amp', 'grok-build'].includes(runtime)) throw new Error('Unsupported Channel runtime');
      const version = await ChannelDiscussionClient.probe(runtime);
      return { available: true, canonicalPath, protocol: 'channel-v1', version };
    }
    const client = this.client(canonicalPath);
    try {
      const initialized = await client.connect();
      assertSupportedServer(initialized);
      return { available: true, canonicalPath, protocol: 'channel-v1', initialized };
    } finally {
      await client.closeAndConfirmTermination();
    }
  }

  private client(cwd: string) {
    return new CodexAppServerClient({
      commandPath: this.commandPath,
      cwd,
      clientVersion: 'channel-mvp',
      env: process.env,
      reconnectMaxAttempts: 0,
      trackProcessTree: true,
    });
  }

  async start(input: CodexChannelStart): Promise<CodexChannelSnapshot> {
    const key = this.key(input.ownerId, input.runId);
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const pending = this.pendingStarts.get(key);
    if (pending) {
      const receipt = await pending;
      if (receipt.inputHash !== inputHash) throw new Error('Run input changed on retry');
      return receipt;
    }
    const start = this.startQueue.then(() => this.startOnce(key, inputHash, input));
    this.startQueue = start.catch(() => {});
    this.pendingStarts.set(key, start);
    try {
      return await start;
    } finally {
      this.pendingStarts.delete(key);
    }
  }

  private async startOnce(key: string, inputHash: string, input: CodexChannelStart) {
    const existing = await this.inspect(input.ownerId, input.runId);
    if (existing) {
      if (existing.fence !== input.fence || existing.inputHash !== inputHash)
        throw new Error('Run input changed on retry');
      return existing;
    }
    const cwd = await realpath(input.cwd);
    if (cwd !== input.cwd)
      throw new Error('Workspace identity changed; rebind the canonical directory');
    // An additional host-local lock guards requests even if multiple server workers race.
    for (const execution of this.runs.values()) {
      if (execution.snapshot.cwd === cwd && !execution.snapshot.physicalStopped)
        throw new Error('Workspace writer is still active');
      if (execution.snapshot.physicalStopped) await execution.done;
    }
    // A host restart does not erase a previous writer's uncertainty.
    await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.journalDirectory)) {
      if (!name.endsWith('.json')) continue;
      const saved: CodexChannelSnapshot = JSON.parse(
        await readFile(path.join(this.journalDirectory, name), 'utf8'),
      );
      if (saved.cwd === cwd && !saved.physicalStopped)
        throw new Error('Workspace has an unconfirmed writer from an earlier host');
    }
    const execution: Execution = {
      client:
        input.runtime && input.runtime !== 'codex'
          ? new ChannelDiscussionClient(input.runtime)
          : this.client(cwd),
      done: Promise.resolve(),
      writes: Promise.resolve(),
      stopping: false,
      snapshot: {
        runId: input.runId,
        fence: input.fence,
        inputHash,
        cwd,
        acceptance: 'pending',
        physicalStopped: false,
        status: 'starting',
      },
    };
    this.runs.set(key, execution);
    // Commit intent before the first native call. Lost acknowledgements become inspect-only.
    await this.persist(key, execution);
    execution.done = this.execute(key, input, execution).catch((error) => {
      execution.snapshot.status = 'execution_unknown';
      execution.snapshot.error = `Could not persist native receipt: ${String(error)}`;
    });
    return structuredClone(execution.snapshot);
  }

  async approve(
    ownerId: string,
    runId: string,
    fence: number,
    approvalId: string,
    approved: boolean,
  ) {
    const execution = this.runs.get(this.key(ownerId, runId));
    if (
      !execution ||
      execution.snapshot.fence !== fence ||
      execution.snapshot.approval?.id !== approvalId ||
      !execution.resolveApproval
    )
      throw new Error('Approval is no longer active');
    if (Date.now() >= execution.snapshot.approval.expiresAt) throw new Error('Approval expired');
    execution.resolveApproval(approved ? 'accept' : 'decline');
  }

  async stop(ownerId: string, runId: string, fence: number) {
    const key = this.key(ownerId, runId);
    const execution = this.runs.get(key);
    if (!execution) return this.inspect(ownerId, runId);
    if (execution.snapshot.fence !== fence) throw new Error('Stale Run authority');
    execution.stopping = true;
    execution.resolveApproval?.('decline');
    // No inference from turn/interrupt: terminate the dedicated group and measure it.
    execution.snapshot.physicalStopped = await execution.client.closeAndConfirmTermination();
    execution.snapshot.status = execution.snapshot.physicalStopped
      ? 'stopped'
      : 'execution_unknown';
    await this.persist(key, execution);
    await execution.done;
    return structuredClone(execution.snapshot);
  }

  private async execute(key: string, input: CodexChannelStart, execution: Execution) {
    const { client, snapshot } = execution;
    if (client instanceof ChannelDiscussionClient) {
      try {
        snapshot.evidence = { baseline: await captureChannelWorkspace(input.cwd), commands: [] };
        await client.run(input, path.join(this.journalDirectory, key), snapshot, () =>
          this.persist(key, execution),
        );
        snapshot.status = 'completed';
      } catch (error) {
        snapshot.error = String(error);
        snapshot.status = execution.stopping ? 'stopped' : 'failed';
        if (snapshot.acceptance === 'pending') snapshot.acceptance = 'unknown';
      } finally {
        snapshot.physicalStopped = await client.closeAndConfirmTermination();
        if (!snapshot.physicalStopped) snapshot.status = 'execution_unknown';
        if (snapshot.status === 'completed' && snapshot.evidence) {
          snapshot.evidence.final = await captureChannelWorkspace(input.cwd);
        }
        await this.persist(key, execution);
      }
      return;
    }
    let timer: ReturnType<typeof setInterval> | undefined;
    let approvalTimer: ReturnType<typeof setTimeout> | undefined;
    const disposers: (() => void)[] = [];
    let activeMs = 0;
    let lastTick = Date.now();
    let tools = 0;
    let modelBudget: Awaited<ReturnType<typeof createChannelModelBudget>> | undefined;
    let budgetError: Error | undefined;
    let rejectBudget: ((error: Error) => void) | undefined;
    try {
      snapshot.evidence = { baseline: await captureChannelWorkspace(input.cwd), commands: [] };
      await this.persist(key, execution);
      assertSupportedServer(await client.connect());
      if (execution.stopping) return;
      const { config } = await client.request<{
        config: {
          chatgpt_base_url?: string;
          model_provider?: string;
          model_providers?: Record<
            string,
            { base_url?: string; aws?: unknown; [key: string]: unknown }
          >;
        };
      }>('config/read', { cwd: input.cwd, includeLayers: false });
      const providerId = config.model_provider || 'openai';
      if (!/^[\w-]+$/.test(providerId)) throw new Error('Unsupported Codex provider identifier');
      const provider = config.model_providers?.[providerId];
      if (provider?.aws)
        throw new Error('Channel model budget does not support AWS signed endpoints');
      const account = await client.request<{ account?: { type: string } }>('account/read', {});
      const upstream =
        provider?.base_url ||
        (providerId === 'openai'
          ? process.env.OPENAI_BASE_URL ||
            (account.account?.type === 'chatgpt'
              ? `${(config.chatgpt_base_url || 'https://chatgpt.com/backend-api').replace(/\/$/, '').replace(/\/codex$/, '')}/codex`
              : 'https://api.openai.com/v1')
          : undefined);
      if (!upstream) throw new Error('Codex provider endpoint cannot be metered');
      modelBudget = await createChannelModelBudget({
        upstream,
        limit: this.modelCallLimit,
        onCall: async (count) => {
          snapshot.modelCalls = count;
          await this.persist(key, execution);
        },
        toolLimit: this.toolCallLimit,
        onTool: async (count) => {
          snapshot.toolCalls = count;
          await this.persist(key, execution);
        },
        onLimit: (error) => {
          budgetError = error;
          rejectBudget?.(error);
        },
      });
      const options = {
        cwd: input.cwd,
        model: input.model || undefined,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        modelProvider: 'channel-budget',
        config: {
          'features.multi_agent': false,
          'features.responses_websockets': false,
          'features.responses_websockets_v2': false,
          'model_providers.channel-budget': {
            ...(providerId === 'openai'
              ? { name: 'OpenAI', requires_openai_auth: true, wire_api: 'responses' }
              : provider),
            base_url: modelBudget.url,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
        developerInstructions: [CHANNEL_INSTRUCTIONS, input.systemRole]
          .filter(Boolean)
          .join('\n\n'),
      };
      const thread = await client.request<ThreadStartResponse>(
        input.sessionId ? 'thread/resume' : 'thread/start',
        { ...options, ...(input.sessionId ? { threadId: input.sessionId } : {}) },
      );
      snapshot.sessionId = thread.thread.id;
      await this.persist(key, execution);
      if (execution.stopping) return;
      let finish!: (content: string) => void;
      let fail!: (error: Error) => void;
      const completed = new Promise<string>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      rejectBudget = fail;
      if (budgetError) fail(budgetError);
      // Attach immediately: turn/completed may precede the turn/start response.
      void completed.catch(() => {});
      disposers.push(client.onDisconnect(fail));
      disposers.push(
        client.subscribe(thread.thread.id, (method, raw) => {
          const params = raw as {
            item?: { type: string; text?: string; phase?: string };
            turn?: {
              status: string;
              items?: { type: string; text?: string }[];
              error?: { message: string };
            };
          };
          if (method === 'item/agentMessage/delta' && snapshot.activity !== 'typing') {
            snapshot.activity = 'typing';
            void this.persist(key, execution).catch(fail);
          } else if (
            method === 'item/started' &&
            params.item?.type !== 'agentMessage' &&
            snapshot.activity === 'typing'
          ) {
            snapshot.activity = 'running';
            void this.persist(key, execution).catch(fail);
          }
          if (method === 'item/completed' && params.item?.type === 'commandExecution')
            snapshot.evidence?.commands.push(params.item);
          if (
            method === 'item/started' &&
            params.item &&
            [
              'commandExecution',
              'fileChange',
              'mcpToolCall',
              'webSearch',
              'dynamicToolCall',
            ].includes(params.item.type) &&
            ++tools > this.toolCallLimit
          )
            fail(new Error('Channel tool call limit reached'));
          snapshot.toolCalls = Math.max(tools, snapshot.toolCalls || 0);
          if (
            method === 'item/completed' &&
            params.item?.type === 'agentMessage' &&
            params.item.phase === 'final_answer'
          )
            snapshot.content = params.item.text;
          if (method === 'turn/completed') {
            if (params.turn?.status !== 'completed')
              fail(new Error(params.turn?.error?.message || `Codex turn ${params.turn?.status}`));
            else
              finish(
                snapshot.content ||
                  params.turn.items?.findLast((item) => item.type === 'agentMessage')?.text ||
                  '',
              );
          }
        }),
      );
      disposers.push(
        client.subscribeServerRequests(thread.thread.id, async (method, request) => {
          if (
            !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
              method,
            )
          )
            throw new Error(`Unsupported native request: ${method}`);
          if (execution.stopping) return { decision: 'decline' };
          snapshot.approval = {
            id: randomUUID(),
            expiresAt: Date.now() + CHANNEL_LIMITS.approvalMs,
            method,
            request,
          };
          snapshot.status = 'awaiting_approval';
          await this.persist(key, execution);
          const decision = await new Promise<'accept' | 'decline'>((resolve) => {
            execution.resolveApproval = resolve;
            approvalTimer = setTimeout(() => resolve('decline'), CHANNEL_LIMITS.approvalMs);
          });
          clearTimeout(approvalTimer);
          execution.resolveApproval = undefined;
          snapshot.approval = undefined;
          snapshot.status = 'running';
          await this.persist(key, execution);
          return { decision };
        }),
      );
      timer = setInterval(() => {
        const now = Date.now();
        if (snapshot.status !== 'awaiting_approval') activeMs += now - lastTick;
        lastTick = now;
        if (activeMs >= CHANNEL_LIMITS.executionMs)
          fail(new Error('Channel execution time limit reached'));
      }, 250);
      snapshot.input = {
        prompt: channelInput(input.manifest),
        systemRole: options.developerInstructions,
        runtime: 'codex',
        resumedSessionId: input.sessionId || null,
      };
      await this.persist(key, execution);
      const turn = await client.request<TurnStartResponse>('turn/start', {
        threadId: thread.thread.id,
        input: [
          {
            type: 'text',
            text: snapshot.input.prompt,
            text_elements: [],
          },
        ],
      });
      snapshot.turnId = turn.turn.id;
      snapshot.acceptance = 'accepted';
      if (!snapshot.approval) snapshot.status = 'running';
      await this.persist(key, execution);
      const content = await completed;
      if (budgetError) throw budgetError;
      if (!content) throw new Error('Codex completed without a final answer');
      snapshot.content = content;
      snapshot.status = 'completed';
      // Save final before cleanup; server recovery can publish without executing another turn.
      await this.persist(key, execution);
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error);
      snapshot.status = execution.stopping ? 'stopped' : 'failed';
      if (snapshot.acceptance === 'pending') snapshot.acceptance = 'unknown';
    } finally {
      clearInterval(timer);
      clearTimeout(approvalTimer);
      execution.resolveApproval?.('decline');
      disposers.forEach((dispose) => dispose());
      const physicalStopped = await client.closeAndConfirmTermination();
      await modelBudget?.close();
      if (!physicalStopped) snapshot.status = 'execution_unknown';
      if (physicalStopped && snapshot.status === 'completed' && snapshot.evidence) {
        try {
          snapshot.evidence.final = await captureChannelWorkspace(input.cwd);
        } catch (error) {
          snapshot.status = 'failed';
          snapshot.error = String(error);
        }
      }
      snapshot.physicalStopped = physicalStopped;
      if (execution.stopping && snapshot.physicalStopped) snapshot.status = 'stopped';
      await this.persist(key, execution);
    }
  }
}
