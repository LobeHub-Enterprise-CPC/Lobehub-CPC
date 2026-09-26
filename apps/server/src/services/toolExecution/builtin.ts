import { CloudSandboxApiName, CloudSandboxIdentifier } from '@lobechat/builtin-tool-cloud-sandbox';
import { LocalSystemApiName, LocalSystemIdentifier } from '@lobechat/builtin-tool-local-system';
import { RemoteDeviceIdentifier } from '@lobechat/builtin-tool-remote-device';
import { builtinTools } from '@lobechat/builtin-tools';
import { type LobeChatDatabase } from '@lobechat/database';
import {
  type ChatToolPayload,
  isWorkSkillProvider,
  type WorkRegistrationIntent,
} from '@lobechat/types';
import { detectTruncatedJSON, safeParseJSON } from '@lobechat/utils';
import debug from 'debug';

import { UserModel } from '@/database/models/user';
import { isShareBlockedBuiltinDispatch } from '@/server/services/aiAgent/shareGate';
import { ComposioService } from '@/server/services/composio';
import {
  checkCommand,
  checkPath,
  COMMAND_BLOCKED_MESSAGE,
  type CommandExecutionTarget,
  type CommandGovernanceContext,
  FILE_BLOCKED_MESSAGE,
  logCommandExecution,
  type PathGovernanceContext,
} from '@/server/services/governance';
import { MarketService } from '@/server/services/market';

import { getServerRuntime, hasServerRuntime } from './serverRuntimes';
import { type IToolExecutor, type ToolExecutionContext, type ToolExecutionResult } from './types';
import { resolveBuiltinToolWorkIntent } from './workRegistration';

const log = debug('lobe-server:builtin-tools-executor');

/**
 * Market rejects a trusted-client token 5 minutes after it was minted, while one
 * executor can outlive that (the inline step loop keeps it for a whole
 * `/api/agent/run` invocation). Rebuild the MarketService — and so re-mint the
 * token — well before the deadline.
 */
const MARKET_SERVICE_MAX_AGE_MS = 4 * 60 * 1000;

/** Market's 401 code for a trusted-client token it refuses (expired, skewed, …). */
const INVALID_TRUST_TOKEN = 'invalid_trust_token';

/**
 * Builtin tool identifiers that can execute a shell command, and therefore
 * are the ones command governance gates. `RemoteDeviceIdentifier` never runs
 * a command itself (it only exposes `activateDevice` / `listOnlineDevices` —
 * see `serverRuntimes/remoteDevice.ts`); it is listed here so a future
 * direct-execution API added to that identifier is covered without another
 * chokepoint change.
 */
const COMMAND_EXECUTION_IDENTIFIERS = new Set<string>([
  LocalSystemIdentifier,
  RemoteDeviceIdentifier,
  CloudSandboxIdentifier,
]);

/** API names, across the identifiers above, that actually spawn a shell command. */
const COMMAND_EXECUTION_API_NAMES = new Set<string>([
  LocalSystemApiName.runCommand,
  CloudSandboxApiName.runCommand,
]);

const FILE_GOVERNANCE_API_NAMES = new Set<string>([
  LocalSystemApiName.writeFile,
  LocalSystemApiName.editFile,
  LocalSystemApiName.moveFiles,
  LocalSystemApiName.readFile,
  LocalSystemApiName.listFiles,
  LocalSystemApiName.searchFiles,
  LocalSystemApiName.grepContent,
  LocalSystemApiName.globFiles,
]);

const resolveCommandExecutionTarget = (
  identifier: string,
  context: ToolExecutionContext,
): CommandExecutionTarget => {
  if (identifier === CloudSandboxIdentifier) return 'sandbox';
  return context.deviceExecutionTarget === 'local' ? 'local' : 'device';
};

/**
 * Resolve the {@link CommandGovernanceContext} for one tool call, or
 * `undefined` when it isn't a governable command execution — keeps the blast
 * radius of a governance bug limited to the APIs that actually spawn a shell,
 * not every builtin tool call.
 */
const buildCommandGovernanceContext = (
  identifier: string,
  apiName: string,
  args: Record<string, any>,
  context: ToolExecutionContext,
  userId: string,
): (CommandGovernanceContext & { commandText: string }) | undefined => {
  if (!COMMAND_EXECUTION_IDENTIFIERS.has(identifier) || !COMMAND_EXECUTION_API_NAMES.has(apiName)) {
    return undefined;
  }

  const executionTarget = resolveCommandExecutionTarget(identifier, context);

  const commandText = typeof args?.command === 'string' ? args.command : JSON.stringify(args ?? {});

  return {
    apiName,
    commandText,
    deviceId: context.activeDeviceId,
    executionTarget,
    toolIdentifier: identifier,
    userId,
  };
};

const resolveFileGovernancePaths = (apiName: string, args: Record<string, any>): string[] => {
  switch (apiName) {
    case LocalSystemApiName.editFile: {
      return typeof args?.file_path === 'string' ? [args.file_path] : [];
    }
    case LocalSystemApiName.moveFiles: {
      if (!Array.isArray(args?.items)) return [];
      return args.items.flatMap((item: any) =>
        [item?.oldPath, item?.newPath].filter(
          (value: unknown): value is string => typeof value === 'string',
        ),
      );
    }
    case LocalSystemApiName.searchFiles:
    case LocalSystemApiName.globFiles: {
      return typeof args?.scope === 'string' ? [args.scope] : [];
    }
    case LocalSystemApiName.grepContent: {
      return [args?.scope, args?.path].filter(
        (value): value is string => typeof value === 'string',
      );
    }
    default: {
      return typeof args?.path === 'string' ? [args.path] : [];
    }
  }
};

const resolveAgainstWorkingDirectory = (
  rawPath: string,
  workingDirectory: string | undefined,
): string => {
  const isAbsolute =
    rawPath.startsWith('/') || rawPath.startsWith('~') || /^[A-Z]:[/\\]/i.test(rawPath);
  const trimmedCwd = workingDirectory?.replace(/[/\\]+$/, '');
  return isAbsolute || !trimmedCwd ? rawPath : `${trimmedCwd}/${rawPath}`;
};

const buildFileGovernanceContexts = (
  identifier: string,
  apiName: string,
  args: Record<string, any>,
  context: ToolExecutionContext,
  userId: string,
): PathGovernanceContext[] => {
  if (identifier !== LocalSystemIdentifier || !FILE_GOVERNANCE_API_NAMES.has(apiName)) return [];

  const rawPaths = resolveFileGovernancePaths(apiName, args);
  if (rawPaths.length === 0) return [];

  const executionTarget = resolveCommandExecutionTarget(identifier, context);

  return rawPaths.map((rawPath) => ({
    apiName,
    deviceId: context.activeDeviceId,
    executionTarget,
    path: resolveAgainstWorkingDirectory(rawPath, context.workingDirectory),
    toolIdentifier: identifier,
    userId,
  }));
};

/**
 * Declared API names for a builtin tool, read from its manifest — the
 * authoritative source. Runtime instances declare their APIs as prototype
 * methods (`async sendMessage() {}`), which `Object.keys` cannot see, so the
 * manifest, not the instance, is the correct source for a recovery hint.
 */
const getManifestApiNames = (identifier: string): string[] =>
  (builtinTools.find((tool) => tool.identifier === identifier)?.manifest?.api ?? []).map(
    (api) => api.name,
  );

/**
 * Required parameter names declared by a builtin API. Prefers the manifest the
 * run was assembled with, falling back to the static builtin manifest.
 */
const getRequiredParams = (
  identifier: string,
  apiName: string,
  context: ToolExecutionContext,
): string[] => {
  const manifest =
    context.toolManifestMap?.[identifier] ??
    builtinTools.find((tool) => tool.identifier === identifier)?.manifest;
  const required = manifest?.api?.find((api) => api.name === apiName)?.parameters?.required;
  return Array.isArray(required) ? required : [];
};

/**
 * Fallback when a manifest isn't available (e.g. a runtime registered without a
 * matching manifest entry): collect callable names across the whole prototype
 * chain — both own arrow-field methods and class prototype methods — which
 * `Object.keys` alone would miss.
 */
const collectRuntimeApiNames = (runtime: Record<string, any>): string[] => {
  const names = new Set<string>();
  for (
    let cur: object | null = runtime;
    cur && cur !== Object.prototype;
    cur = Object.getPrototypeOf(cur)
  ) {
    for (const key of Object.getOwnPropertyNames(cur)) {
      if (key !== 'constructor' && typeof runtime[key] === 'function') names.add(key);
    }
  }
  return [...names];
};

export class BuiltinToolsExecutor implements IToolExecutor {
  private db: LobeChatDatabase;
  private userId: string;
  private _marketService?: { createdAt: number; service: MarketService };

  constructor(db: LobeChatDatabase, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  private async getMarketService({ fresh }: { fresh?: boolean } = {}): Promise<MarketService> {
    if (
      !fresh &&
      this._marketService &&
      Date.now() - this._marketService.createdAt < MARKET_SERVICE_MAX_AGE_MS
    )
      return this._marketService.service;

    let accessToken: string | undefined;
    try {
      const userModel = new UserModel(this.db, this.userId);
      const settings = await userModel.getUserSettings();
      accessToken = (settings?.market as any)?.accessToken;
    } catch {
      // non-fatal — MarketService will fall back to trustedClientToken
    }

    const service = new MarketService({
      accessToken,
      userInfo: { userId: this.userId },
    });
    this._marketService = { createdAt: Date.now(), service };
    return service;
  }

  async execute(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: argsStr, source } = payload;

    // An empty arguments string means the call reached us without any argument
    // deltas (not generated, or dropped by the provider / an OpenAI-compatible
    // proxy in transit). Falling back to `{}` for an API with required params
    // surfaced as a misleading tool error (e.g. "command is required") that the
    // model blamed on the platform. APIs without required params keep `{}`.
    if (!argsStr?.trim()) {
      const required = getRequiredParams(identifier, apiName, context);
      if (required.length > 0) {
        const message =
          `The tool call arrived with an empty arguments string, so the tool was not invoked. ` +
          `The arguments were either not generated or lost in transit before reaching the tool. ` +
          `Resend the call with the complete JSON arguments, including the required parameters: ` +
          `${required.join(', ')}.`;
        log('Rejected empty arguments for %s:%s', identifier, apiName);
        return {
          content: message,
          error: { code: 'EMPTY_ARGUMENTS', message },
          success: false,
        };
      }
    }

    const parsed = safeParseJSON(argsStr);

    // When JSON.parse fails, return a dedicated error rather than silently
    // falling back to `{}`. Passing `{}` to the tool produced generic
    // "required field missing" errors, which led the model to retry with the
    // same broken payload. Distinguish a truncated payload (typical when
    // max_tokens is exhausted mid-tool-call) from plain malformed JSON, and
    // echo the raw arguments string so the model can verify it is exactly
    // what it produced.
    if (parsed === undefined && argsStr?.trim()) {
      const truncationReason = detectTruncatedJSON(argsStr);
      const explanation = truncationReason
        ? `The tool call arguments JSON appears to be truncated (${truncationReason}), ` +
          `likely because the model's max_tokens budget was exhausted ` +
          `(possibly by extended-thinking tokens). ` +
          `Either reduce the size of the content you are about to write, ` +
          `or ask the user to increase the model's max_tokens ` +
          `(and/or disable extended thinking or set a separate thinking budget). ` +
          `Do not retry with the same payload.`
        : `The tool call arguments string is not valid JSON and could not be parsed, ` +
          `so the tool was not invoked. Fix the JSON syntax and try again.`;
      const content = `${explanation}\n\nThe received arguments string was:\n${argsStr}`;
      const code = truncationReason ? 'TRUNCATED_ARGUMENTS' : 'INVALID_JSON_ARGUMENTS';
      log('Rejected invalid arguments for %s:%s (%s): %s', identifier, apiName, code, argsStr);
      return {
        content,
        error: { code, message: explanation },
        success: false,
      };
    }

    const args = parsed || {};

    // Share-visitor gate at the ACTUAL dispatch site. The assembly-time tool-set
    // trim (`applyShareGateToToolSet`) only shapes what the model is offered —
    // this executor runs whatever call reaches it, so a resume path, recovery
    // hint, or future tool-discovery route that bypasses assembly must still
    // clear the FULL gate here: master default-deny allowlist, the owner's
    // `toolGrants` picker, humanIntervention policy (re-read from the
    // unstripped manifest), and the per-API data-tool rules. Non-builtin
    // identifiers pass through (governed by the share's `toolGrants` at
    // assembly). Fail closed: block, never throw open.
    if (
      context.agentShareVisitor &&
      isShareBlockedBuiltinDispatch(context.agentShareVisitor, identifier, apiName, args)
    ) {
      log('Share gate blocked builtin dispatch: %s:%s', identifier, apiName);
      return {
        content: `The tool API ${identifier}:${apiName} is not available in this shared conversation.`,
        error: { code: 'SHARE_GATE_BLOCKED', message: 'Tool call blocked by agent share gate' },
        success: false,
      };
    }

    log(
      'Executing builtin tool: %s:%s (source: %s) with args: %O',
      identifier,
      apiName,
      source,
      args,
    );

    // Route LobeHub Skills to MarketService
    if (source === 'lobehubSkill') {
      const callSkill = (marketService: MarketService) =>
        marketService.executeLobehubSkill({
          args,
          context: {
            topicId: context.topicId,
          },
          provider: identifier,
          timeoutMs: context.executionTimeoutMs,
          toolName: apiName,
        });

      let result = await callSkill(await this.getMarketService());

      // Market refuses the token at its auth middleware, before the skill runs,
      // so re-minting and retrying once cannot repeat a side effect.
      if (result.error?.code === INVALID_TRUST_TOKEN) {
        log('Trust token rejected for %s:%s, retrying with a fresh token', identifier, apiName);
        result = await callSkill(await this.getMarketService({ fresh: true }));
      }

      if (result.success && isWorkSkillProvider(identifier)) {
        // Defer Work registration to the agent runtime so the version is written
        // ONCE with its cumulative cost (known only after execution). Carry the
        // UNTRUNCATED payload here: the runtime only sees the truncated
        // `content`, but skill identity (issue/PR url, number, …) lives
        // exclusively in the raw result.
        return {
          ...result,
          workRegistration: {
            args,
            data: safeParseJSON(result.content) ?? result.content,
            provider: identifier,
            toolName: apiName,
            type: 'skill',
          },
        };
      }

      return result;
    }

    // Route Composio tools to ComposioService. Build it request-scoped: agentId
    // and workspaceId live on the per-call context (not known at construction),
    // so a workspace run resolves workspace connectors and a
    // service-account agent runs off its own Composio account
    // (Agent > Workspace/Personal).
    if (source === 'composio') {
      const composioService = new ComposioService({
        db: this.db,
        userId: this.userId,
        workspaceId: context.workspaceId,
      });
      return composioService.executeComposioTool({
        agentId: context.agentId,
        args,
        identifier,
        toolSlug: apiName,
      });
    }

    // Use server runtime registry (handles both pre-instantiated and per-request runtimes)
    if (!hasServerRuntime(identifier)) {
      throw new Error(`Builtin tool "${identifier}" is not implemented`);
    }

    // Await runtime in case factory is async
    const runtime = await getServerRuntime(identifier, context);

    if (typeof runtime[apiName] !== 'function') {
      // An unknown apiName is almost always a model hallucination (calling an
      // API that the tool never declared in its manifest). Return a structured,
      // recoverable error listing the tool's real APIs instead of throwing a
      // hard error the model cannot act on. The throw here also sits outside
      // the try/catch below, so it would otherwise surface as an uncaught
      // failure rather than a tool result.
      //
      // Prefer the manifest's declared API names; most runtimes declare their
      // APIs as prototype methods that `Object.keys(runtime)` cannot see, which
      // would collapse the hint to an empty list. Fall back to a prototype-chain
      // walk only when no manifest is available.
      const manifestApis = getManifestApiNames(identifier);
      const availableApis =
        manifestApis.length > 0 ? manifestApis : collectRuntimeApiNames(runtime);
      const message =
        `Builtin tool "${identifier}" has no API named "${apiName}". ` +
        `Available APIs: ${availableApis.join(', ')}. ` +
        `Do not call APIs that are not listed above.`;
      log('Unknown apiName for %s: %s (available: %o)', identifier, apiName, availableApis);
      return {
        content: message,
        error: { code: 'UNKNOWN_API', message },
        success: false,
      };
    }

    // Command governance: gate command-shaped calls only (see
    // `buildCommandGovernanceContext`). `checkCommand` itself no-ops to
    // `{ allowed: true }` with zero DB access when the feature is disabled
    // (`COMMAND_GOVERNANCE_ENABLED`), so this is a no-op in the default
    // configuration.
    const commandGovernance = buildCommandGovernanceContext(
      identifier,
      apiName,
      args,
      context,
      this.userId,
    );

    if (commandGovernance) {
      const decision = await checkCommand(commandGovernance, this.db);

      if (!decision.allowed) {
        log(
          'Blocked command for %s:%s (rule %s): %s',
          identifier,
          apiName,
          decision.ruleId,
          commandGovernance.commandText,
        );

        // logCommandExecution never throws by design (it fails open and only
        // debug-logs internally) — wrapped anyway so a future change to that
        // contract can never turn an audit-log bug into a masked tool result.
        try {
          await logCommandExecution(
            commandGovernance,
            { blocked: true, matchedRuleId: decision.ruleId },
            this.db,
          );
        } catch (auditError) {
          log('Failed to record blocked-command audit log: %O', auditError);
        }

        return {
          content: COMMAND_BLOCKED_MESSAGE,
          error: { code: 'COMMAND_BLOCKED', message: COMMAND_BLOCKED_MESSAGE },
          success: false,
        };
      }
    }

    const fileGovernanceContexts = buildFileGovernanceContexts(
      identifier,
      apiName,
      args,
      context,
      this.userId,
    );

    for (const candidate of fileGovernanceContexts) {
      const decision = await checkPath(candidate, this.db);

      if (!decision.allowed) {
        log(
          'Blocked file access for %s:%s (field %s): %s',
          identifier,
          apiName,
          decision.matchedField,
          candidate.path,
        );

        try {
          await logCommandExecution(
            candidate,
            { blocked: true, matchedField: decision.matchedField },
            this.db,
          );
        } catch (auditError) {
          log('Failed to record blocked-file-access audit log: %O', auditError);
        }

        return {
          content: FILE_BLOCKED_MESSAGE,
          error: { code: 'FILE_ACCESS_BLOCKED', message: FILE_BLOCKED_MESSAGE },
          success: false,
        };
      }
    }

    const fileGovernance = fileGovernanceContexts[0];

    const commandGovernanceStartedAt = commandGovernance ? Date.now() : undefined;
    const fileGovernanceStartedAt = fileGovernance ? Date.now() : undefined;

    try {
      // Install a sink for runtimes whose Work registration is a side-effect
      // decoupled from the returned result (the agentDocuments runtime emits its
      // intent here instead of writing the version directly).
      let collectedWorkIntent: WorkRegistrationIntent | undefined;
      context.onWorkRegistration = (intent) => {
        collectedWorkIntent = intent;
      };

      const result = await runtime[apiName](args, context);

      if (commandGovernance) {
        try {
          await logCommandExecution(
            commandGovernance,
            {
              blocked: false,
              durationMs: Date.now() - commandGovernanceStartedAt!,
              success: result.success,
            },
            this.db,
          );
        } catch (auditError) {
          log('Failed to record command execution audit log: %O', auditError);
        }
      }

      if (fileGovernance) {
        try {
          await logCommandExecution(
            fileGovernance,
            {
              blocked: false,
              durationMs: Date.now() - fileGovernanceStartedAt!,
              success: result.success,
            },
            this.db,
          );
        } catch (auditError) {
          log('Failed to record file access audit log: %O', auditError);
        }
      }

      // Manifest-driven Work registration: resolve the intent from the API's
      // declarative `work` config + result/args and hand it to the agent
      // runtime, which persists the Work version ONCE with its cumulative cost.
      // Falls back to the intent a runtime emitted via `onWorkRegistration`
      // (documents). No-op unless the API declares a `work` config or emits one.
      //
      // Best-effort: Work-intent resolution is post-hoc bookkeeping over an
      // already-successful tool call, so a bug in the resolver must not turn a
      // succeeded mutation into a reported tool failure. Isolate it from the
      // execution try/catch below and swallow-and-log instead.
      let workRegistration: WorkRegistrationIntent | undefined;
      try {
        workRegistration =
          resolveBuiltinToolWorkIntent(identifier, apiName, { args, result }) ??
          collectedWorkIntent;
      } catch (workError) {
        log(
          'Work registration intent resolution failed for %s:%s: %O',
          identifier,
          apiName,
          workError,
        );
      }

      return workRegistration ? { ...result, workRegistration } : result;
    } catch (e) {
      const error = e as Error;
      console.error('Error executing builtin tool %s:%s: %O', identifier, apiName, error);

      if (commandGovernance) {
        try {
          await logCommandExecution(
            commandGovernance,
            {
              blocked: false,
              durationMs: Date.now() - commandGovernanceStartedAt!,
              errorMessage: error.message,
              success: false,
            },
            this.db,
          );
        } catch (auditError) {
          log('Failed to record command execution audit log: %O', auditError);
        }
      }

      if (fileGovernance) {
        try {
          await logCommandExecution(
            fileGovernance,
            {
              blocked: false,
              durationMs: Date.now() - fileGovernanceStartedAt!,
              errorMessage: error.message,
              success: false,
            },
            this.db,
          );
        } catch (auditError) {
          log('Failed to record file access audit log: %O', auditError);
        }
      }

      return { content: error.message, error, success: false };
    }
  }
}
