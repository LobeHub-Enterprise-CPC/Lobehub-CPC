/** Channel identities never alias legacy Group, Topic, Task or Operation identities. */
export type ChannelRuntime = 'native' | 'codex' | 'amp' | 'grok-build';
export type ChannelJobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type ChannelRunStatus =
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'stop_requested'
  | 'execution_unknown'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface ChannelMemberConfig {
  agentId?: string;
  avatar?: string;
  backgroundColor?: string;
  deviceId?: string;
  model: string;
  provider: string;
  runtime: ChannelRuntime;
  systemRole?: string;
  /** Set only from a device's canonical-path acknowledgement before claiming work. */
  workingDirectory?: string;
}

export interface ChannelContextMessage {
  author: { id: string; name: string; type: 'human' | 'member' };
  content: string;
  id: string;
  sequence: number;
  threadId: string | null;
}

export interface ChannelInputManifest {
  /** Immutable at claim time; later public messages belong to the next run. */
  cutoffSequence: number;
  /** Snapshot for a new session; otherwise only messages not yet accepted by this session. */
  messages: ChannelContextMessage[];
  requestMessageId: string;
  sessionGeneration: number;
  /** Serialized to the CLI as contextMode: reconstructed -> snapshot, incremental -> delta. */
  source: 'incremental' | 'reconstructed';
  threadId: string | null;
}

export const CHANNEL_LIMITS = {
  approvalMs: 24 * 60 * 60 * 1000,
  executionMs: 10 * 60 * 1000,
  members: 4,
  modelCalls: 32,
  routerInputTokens: 4000,
  routerMessages: 8,
  routerOutputTokens: 256,
  routerTimeoutMs: 2000,
  toolCalls: 64,
} as const;
