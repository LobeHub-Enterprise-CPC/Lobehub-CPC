import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  ChannelInputManifest,
  ChatImageItem,
  HeterogeneousProviderConfig,
} from '@lobechat/types';

import {
  ChannelAgentClient,
  type ChannelAgentRuntime,
  ChannelBindingChangedError,
  type PrepareChannelLaunch,
  prepareChannelLaunch,
  type ProbeChannelAgent,
} from './agentClient';
import type { ChannelWorkspaceSnapshot } from './snapshot';

export interface CodexChannelStart {
  /** Owner-resolved context, refreshed on dispatch; stable identity is in manifest.fileIds. */
  attachmentContext?: { messageId: string; content: string; imageList: ChatImageItem[] }[];
  cwd: string;
  fence: number;
  manifest: ChannelInputManifest;
  model: string;
  ownerId: string;
  /** Ephemeral, owner-resolved launch configuration; never stored in the receipt. */
  provider?: HeterogeneousProviderConfig;
  runId: string;
  runtime?: ChannelAgentRuntime;
  /** Scoped operation token, kept out of persisted receipts. */
  serverDefaultBinding?: { model: string; token: string };
  sessionId?: string | null;
  systemRole?: string;
}

export interface CodexChannelSnapshot {
  acceptance: 'pending' | 'accepted' | 'unknown';
  activity?: 'running' | 'typing';
  approval?: { expiresAt: number; id: string; method: string; request: unknown };
  bindingKey?: string;
  content?: string;
  cwd: string;
  error?: string;
  /** Retained for receipts produced by earlier Desktops, not required for delivery. */
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
  /** Native turn completed; background tools retain their normal standalone lifetime. */
  runtimeCompleted?: boolean;
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
  client: ChannelAgentClient;
  done: Promise<void>;
  ownerId: string;
  runtime: ChannelAgentRuntime;
  savedSessionId?: string;
  snapshot: CodexChannelSnapshot;
  stopping: boolean;
  writes: Promise<void>;
}

/** Durable delivery receipts around the shared Agent runtime, not another execution policy. */
export class CodexChannelHost {
  private readonly runs = new Map<string, Execution>();
  private readonly pendingStarts = new Map<string, Promise<CodexChannelSnapshot>>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly journalDirectory: string,
    private readonly prepare?: PrepareChannelLaunch,
    private readonly probeAgent: ProbeChannelAgent = ChannelAgentClient.probe,
  ) {}

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
    const { sessionId, bindingKey } = execution.snapshot;
    execution.writes = execution.writes.then(async () => {
      if (sessionId && bindingKey && sessionId !== execution.savedSessionId) {
        await this.write(
          this.sessionKey(execution.ownerId, execution.runtime, sessionId),
          JSON.stringify(bindingKey),
        );
        execution.savedSessionId = sessionId;
      }
      await this.write(key, data);
    });
    return execution.writes;
  }

  private sessionKey(ownerId: string, runtime: string, sessionId: string) {
    return `session-${this.key(ownerId, JSON.stringify([runtime, sessionId]))}`;
  }

  private async write(key: string, data: string) {
    await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file(key)}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.file(key));
      // Windows refuses to fsync a directory handle (Node reports EPERM), which failed
      // every receipt write and left Channel runs unconfirmed. NTFS journals the
      // rename's metadata itself, so the directory sync is a POSIX-only step.
      if (process.platform !== 'win32') {
        const directory = await open(this.journalDirectory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  async inspect(ownerId: string, runId: string): Promise<CodexChannelSnapshot | null> {
    const key = this.key(ownerId, runId);
    const live = this.runs.get(key);
    if (live) {
      if (live.snapshot.physicalStopped || live.snapshot.runtimeCompleted) await live.done;
      await live.writes;
      return structuredClone(live.snapshot);
    }
    try {
      const saved: CodexChannelSnapshot = JSON.parse(await readFile(this.file(key), 'utf8'));
      if (!saved.physicalStopped && !saved.runtimeCompleted)
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

  async probe(
    cwd: string,
    runtime: ChannelAgentRuntime = 'codex',
    provider?: HeterogeneousProviderConfig,
  ) {
    const canonicalPath = await realpath(cwd);
    const version = await this.probeAgent(canonicalPath, runtime, provider);
    return { available: true, attachments: true, canonicalPath, protocol: 'channel-v1', version };
  }

  async start(input: CodexChannelStart): Promise<CodexChannelSnapshot> {
    const key = this.key(input.ownerId, input.runId);
    // Reissuing a scoped credential does not change the message being delivered.
    const {
      serverDefaultBinding: _credential,
      attachmentContext: _attachments,
      ...identity
    } = input;
    const inputHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
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
    const execution: Execution = {
      client: new ChannelAgentClient(async (request) => {
        const launch = await (this.prepare ?? prepareChannelLaunch)(request);
        try {
          if (request.sessionId) {
            const previous = await readFile(
              this.file(
                this.sessionKey(request.ownerId, request.runtime ?? 'codex', request.sessionId),
              ),
              'utf8',
            ).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'null';
              throw error;
            });
            if (JSON.parse(previous) !== (launch.bindingKey ?? 'subscription'))
              throw new ChannelBindingChangedError();
          }
          return launch;
        } catch (error) {
          await launch.cleanup?.();
          throw error;
        }
      }),
      done: Promise.resolve(),
      ownerId: input.ownerId,
      runtime: input.runtime ?? 'codex',
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
    // Intent precedes native input. A lost receipt is inspected, never blindly replayed.
    await this.persist(key, execution);
    execution.done = this.execute(key, input, execution)
      .then(async () => {
        if (execution.snapshot.physicalStopped) {
          await execution.writes;
          this.runs.delete(key);
        }
      })
      .catch(() => {
        execution.snapshot.status = 'execution_unknown';
        execution.snapshot.error = 'Could not persist Agent receipt';
      });
    return structuredClone(execution.snapshot);
  }

  // Older receipts may contain a Channel-owned approval; never silently approve it.
  async approve(
    _ownerId: string,
    _runId: string,
    _fence: number,
    _approvalId: string,
    _approved: boolean,
  ) {
    throw new Error('Approval is no longer active; use the Agent native permission flow');
  }

  async stop(ownerId: string, runId: string, fence: number) {
    const key = this.key(ownerId, runId);
    const execution = this.runs.get(key);
    if (!execution) {
      const saved = await this.inspect(ownerId, runId);
      if (saved && saved.fence !== fence) throw new Error('Stale Run authority');
      // A completed turn is not proof that background processes stopped after a restart.
      return saved && !saved.physicalStopped
        ? { ...saved, status: 'execution_unknown' as const }
        : saved;
    }
    if (execution.snapshot.fence !== fence) throw new Error('Stale Run authority');
    execution.stopping = true;
    execution.snapshot.physicalStopped = await execution.client.closeAndConfirmTermination();
    execution.snapshot.status = execution.snapshot.physicalStopped
      ? 'stopped'
      : 'execution_unknown';
    await this.persist(key, execution);
    await execution.done;
    if (execution.snapshot.physicalStopped) this.runs.delete(key);
    return structuredClone(execution.snapshot);
  }

  private async execute(key: string, input: CodexChannelStart, execution: Execution) {
    const { client, snapshot } = execution;
    try {
      await client.run(input, snapshot, () => this.persist(key, execution));
      snapshot.status = 'completed';
    } catch (error) {
      snapshot.error =
        error instanceof ChannelBindingChangedError
          ? error.message
          : 'Agent execution did not complete; inspect the native session';
      snapshot.status = execution.stopping ? 'stopped' : 'failed';
      if (snapshot.acceptance === 'pending') snapshot.acceptance = 'unknown';
    } finally {
      if (!snapshot.runtimeCompleted || execution.stopping) {
        snapshot.physicalStopped = await client.closeAndConfirmTermination();
        if (!snapshot.physicalStopped) snapshot.status = 'execution_unknown';
        else if (execution.stopping) snapshot.status = 'stopped';
      }
      await this.persist(key, execution);
    }
  }
}
