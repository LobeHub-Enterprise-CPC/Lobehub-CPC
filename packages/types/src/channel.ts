/** Channel identities never alias legacy Group, Topic, Task or Operation identities. */
export type ChannelRuntime = (typeof CHANNEL_RUNTIMES)[number];
export type ChannelMode = 'normal' | 'discussion';
export type ChannelJobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type ChannelDiscussionStatus = 'active' | 'summarizing' | 'completed' | 'stopped';
export interface ChannelDiscussionTask {
  kind: 'discuss' | 'revise' | 'summarize';
  previousRunId?: string;
  /** Round this opportunity belongs to. Absent on summaries and on legacy rows. */
  round?: number;
}
export type ChannelPublicationStatus = 'pending' | 'held' | 'yielded' | 'published';
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
  discussion?: {
    id: string;
    kind: 'discuss' | 'revise' | 'summarize';
    /** Budget of rounds. In each round every participant gets one turn to publish or yield. */
    maxRounds: number;
    participants?: { memberId: string; name: string }[];
    /** 1-based round this opportunity belongs to; the final round for summarize. */
    round: number;
    /** The immutable candidate was held, never published. Continue without replaying tools. */
    heldDraft?: string;
  };
  /** Snapshot for a new session; otherwise only messages not yet accepted by this session. */
  messages: ChannelContextMessage[];
  requestMessageId: string;
  /** Fixed at claim time. Absent only in persisted runs created before identity delivery. */
  self?: { memberId: string; name: string };
  sessionGeneration: number;
  /** Serialized to the CLI as contextMode: reconstructed -> snapshot, incremental -> delta. */
  source: 'incremental' | 'reconstructed';
  threadId: string | null;
  /** Main-channel prefix visible to this branch; null for main, absent in legacy runs. */
  threadRootSequence?: number | null;
}

export const CHANNEL_LIMITS = {
  /** Default number of discussion rounds when the sender sets no explicit limit. */
  discussionRounds: 3,
  maxDiscussionRounds: 10,
  approvalMs: 24 * 60 * 60 * 1000,
  executionMs: 10 * 60 * 1000,
  members: 6,
  minMembers: 2,
  modelCalls: 32,
  routerMessages: 8,
  toolCalls: 64,
} as const;

export const CHANNEL_PRESENCE = {
  snapshotMs: 1000,
  streamMs: 15000,
  fallbackMs: 5000,
  retryMs: 2000,
  retryMaxMs: 30000,
} as const;

export const CHANNEL_HISTORY = { pageSize: 50 } as const;
export const CHANNEL_RUNTIMES = [
  'native',
  'codex',
  'amp',
  'grok-build',
  'claude-code',
  'pi',
] as const;

export function isChannelRuntime(runtime: string): runtime is ChannelRuntime {
  return (CHANNEL_RUNTIMES as readonly string[]).includes(runtime);
}
