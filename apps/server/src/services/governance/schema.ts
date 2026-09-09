import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Database schema for command governance and per-user execution policy.
 *
 * ## Why this lives here and not in `packages/database/src/schemas`
 *
 * These three tables are ours, not upstream's. While they sat in the submodule's
 * schema barrel they were also in the submodule's drizzle chain, which collided
 * with canary's migration indices on every merge — `0158`/`0159` had to be
 * renumbered to `0161`/`0162` once already, snapshots rebuilt by hand each time.
 *
 * Ownership now sits with the shell repo's enterprise chain
 * (`packages/enterprise/src/database/migrations`, bookkeeping in
 * `__drizzle_enterprise_migrations`), which has its own journal and snapshot
 * chain and therefore cannot collide with canary's. This file is the single
 * definition of the tables: the shell's `packages/enterprise/drizzle.config.ts`
 * lists it alongside its own schemas, so `drizzle-kit generate` picks it up from
 * here. `packages/database/migrations` is once again byte-identical to canary.
 *
 * Two consequences worth knowing before editing:
 *
 * 1. **Self-contained on purpose.** No `@/database/schemas/_helpers` import, and
 *    no path alias of any kind: `drizzle-kit` reads this file from the shell
 *    root, where the submodule's tsconfig aliases do not resolve. The timestamp
 *    columns are spelled out below instead.
 * 2. **No `.references(() => users.id)`.** `users` belongs to the submodule's
 *    chain; importing it would pull it into the enterprise config's schema graph
 *    and `drizzle-kit generate` would try to create `users` there too. The three
 *    foreign keys to `users` still exist in the database — they are written by
 *    hand in `0008_command_governance.sql`. Keep them in sync if these columns
 *    change.
 */

const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAtColumn = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** How a rule's `pattern` is matched against the command text. */
export const commandGovernancePatternTypes = ['exact', 'prefix', 'regex'] as const;
export type CommandGovernancePatternType = (typeof commandGovernancePatternTypes)[number];

/**
 * Which execution surface a rule applies to. `all` matches every target;
 * `local` (the user's own paired desktop) is distinguished from `device`
 * (another `lh connect`-linked device) via `context.deviceExecutionTarget`,
 * the run's resolved `ExecutionPlan.target` — see `resolveCommandExecutionTarget`
 * in `builtin.ts`. Falls back to `device` when that signal is absent (a
 * legacy/resumed run with no execution plan).
 */
export const commandGovernanceScopes = ['all', 'local', 'device', 'sandbox'] as const;
export type CommandGovernanceScope = (typeof commandGovernanceScopes)[number];

/**
 * Rule action. Only `deny` exists today (an allowlist/`warn` mode is a
 * plausible follow-up) — stored as free text rather than a DB enum so adding
 * one doesn't require a migration.
 */
export const commandGovernanceRules = pgTable(
  'command_governance_rules',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),

    userId: text('user_id').notNull(),

    pattern: text('pattern').notNull(),
    patternType: text('pattern_type', { enum: commandGovernancePatternTypes }).notNull(),
    scope: text('scope', { enum: commandGovernanceScopes }).notNull().default('all'),
    /** Currently only 'deny'; free text to allow future actions without a migration. */
    action: text('action').notNull().default('deny'),

    enabled: boolean('enabled').default(true).notNull(),

    /** Admin identifier that created the rule (opaque to this table). */
    createdBy: text('created_by'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    index('command_governance_rules_user_id_idx').on(t.userId),
    index('command_governance_rules_user_id_enabled_idx').on(t.userId, t.enabled),
  ],
);

export type CommandGovernanceRuleItem = typeof commandGovernanceRules.$inferSelect;
export type NewCommandGovernanceRule = typeof commandGovernanceRules.$inferInsert;

/** Where a governed command actually ran. Mirrors `CommandExecutionTarget`. */
export const commandExecutionTargets = ['local', 'device', 'sandbox'] as const;
export type CommandExecutionTargetDB = (typeof commandExecutionTargets)[number];

/**
 * Which `user_execution_policies` field a blocked file-access attempt
 * matched. Only set on file-operation rows (`apiName` is `writeFile` /
 * `editFile` / etc, not `runCommand`) — see `pathPolicy.ts`.
 */
export const commandExecutionLogPolicyFields = ['deniedWriteRoots', 'deniedReadRoots'] as const;
export type CommandExecutionLogPolicyField = (typeof commandExecutionLogPolicyFields)[number];

/**
 * One row per governed command-execution OR file-access tool call — an audit
 * trail of every command/file operation a user's agent attempted, whether it
 * was allowed or blocked.
 *
 * Two disjoint shapes share this table (see `pathPolicy.ts`'s `checkPath` vs
 * `policyGate.ts`'s `checkCommand`), distinguished by whether `apiName` is a
 * command-execution API (`runCommand`/`execScript`) or a file-operation API
 * (`writeFile`/`editFile`/`readFile`/...):
 * - command rows: `commandText` set, `matchedRuleId` may be set, `path`/
 *   `policyField` both null.
 * - file-operation rows: `path`/`policyField` set (when blocked),
 *   `commandText`/`matchedRuleId` both null (there is no "command text" for a
 *   file operation, and the match came from `user_execution_policies`, not
 *   `command_governance_rules`).
 */
export const commandExecutionLogs = pgTable(
  'command_execution_logs',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),

    userId: text('user_id').notNull(),

    executionTarget: text('execution_target', { enum: commandExecutionTargets }).notNull(),
    deviceId: text('device_id'),

    toolIdentifier: text('tool_identifier').notNull(),
    apiName: text('api_name').notNull(),
    /** Null for file-operation rows — see the table doc comment. */
    commandText: text('command_text'),

    blocked: boolean('blocked').notNull(),
    matchedRuleId: uuid('matched_rule_id').references(() => commandGovernanceRules.id, {
      onDelete: 'set null',
    }),

    /** File-operation rows only — the target path that was checked. */
    path: text('path'),
    /** File-operation rows only — which `user_execution_policies` field matched a block. */
    policyField: text('policy_field', { enum: commandExecutionLogPolicyFields }),

    /** Null when the command was blocked before it ever ran. */
    success: boolean('success'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),

    createdAt: createdAtColumn(),
  },
  (t) => [
    index('command_execution_logs_user_id_idx').on(t.userId),
    index('command_execution_logs_created_at_idx').on(t.createdAt),
    index('command_execution_logs_execution_target_idx').on(t.executionTarget),
    index('command_execution_logs_blocked_idx').on(t.blocked),
  ],
);

export type CommandExecutionLogItem = typeof commandExecutionLogs.$inferSelect;
export type NewCommandExecutionLog = typeof commandExecutionLogs.$inferInsert;

// ---------------------------------------------------------------------------
// User-level execution policy
//
// Deliberately separate from the command tables above: those are a command-text
// blacklist for the cloud sandbox (a one-shot, already-isolated environment
// where the AIO API accepts no policy parameters), this one is a per-user
// filesystem/network allowlist for surfaces that share the host.
// ---------------------------------------------------------------------------

/**
 * `auto` leaves the existing per-device/per-run negotiation
 * (`decideSandbox`) in charge; `host`/`sandbox` force every run on this
 * user's surfaces to skip or use the Local Sandbox respectively. Defaults to
 * `sandbox` — a policy row existing at all is the admin opting this user into
 * being fenced, so the default must not let a run quietly skip it.
 */
export const userExecutionPolicyCommandModes = ['auto', 'host', 'sandbox'] as const;
export type UserExecutionPolicyCommandMode = (typeof userExecutionPolicyCommandModes)[number];

export const userExecutionPolicies = pgTable('user_execution_policies', {
  id: uuid('id').defaultRandom().primaryKey().notNull(),

  userId: text('user_id').notNull().unique(),

  enabled: boolean('enabled').default(true).notNull(),

  // Filesystem — field names mirror `SandboxPolicy` 1:1 so the server can
  // pass a fetched row straight through without a translation layer.
  writableRoots: jsonb('writable_roots').$type<string[]>().notNull().default([]),
  readableRoots: jsonb('readable_roots').$type<string[]>(),
  deniedWriteRoots: jsonb('denied_write_roots').$type<string[]>(),
  deniedReadRoots: jsonb('denied_read_roots').$type<string[]>(),

  // Network
  allowNetwork: boolean('allow_network').default(false).notNull(),
  allowedNetworkDomains: jsonb('allowed_network_domains').$type<string[]>(),

  // Other
  envAllowlist: jsonb('env_allowlist').$type<string[]>(),
  commandMode: text('command_mode', { enum: userExecutionPolicyCommandModes })
    .notNull()
    .default('sandbox'),

  /** Admin identifier that created/last edited the policy (opaque to this table). */
  createdBy: text('created_by'),

  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type UserExecutionPolicyItem = typeof userExecutionPolicies.$inferSelect;
export type NewUserExecutionPolicy = typeof userExecutionPolicies.$inferInsert;
