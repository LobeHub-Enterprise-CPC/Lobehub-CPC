import { randomUUID } from 'node:crypto';
import posixPath from 'node:path/posix';

import {
  CloudSandboxIdentifier,
  type SandboxCallToolResult,
  type SandboxExportFileResult,
  selectSandboxInitFiles,
} from '@lobechat/builtin-tool-cloud-sandbox';
import { getLocalImageMimeType, MAX_IMAGE_READ_BYTES } from '@lobechat/local-file-shell/read-image';
import debug from 'debug';
import { sha256 } from 'js-sha256';

import { FileModel } from '@/database/models/file';
import {
  checkCommand,
  COMMAND_BLOCKED_MESSAGE,
  type CommandGovernanceContext,
  GOVERNANCE_UNAVAILABLE_MESSAGE,
  GovernanceUnavailableError,
  isGovernanceEnabled,
  logCommandExecution,
} from '@/server/services/governance';

import {
  buildSandboxFilesInitCommand,
  SANDBOX_INIT_TIMEOUT_MS,
  type SandboxInitDownload,
} from './bootstrap';
import {
  buildSandboxEnvironmentInitCommand,
  environmentInitRan,
  environmentInitReport,
  SANDBOX_ENVIRONMENT_INIT_TIMEOUT_MS,
} from './environmentInit';
import { isSandboxAccessDeniedError, isSandboxAuthError } from './errors';
import { callTenantSandboxTool } from './tenantWork';
import type {
  SandboxCommandResult,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderKind,
  SandboxService,
  SandboxServiceOptions,
} from './types';

const log = debug('lobe-server:sandbox:service');

/**
 * Sandbox tool names that execute arbitrary code, and therefore are the ones
 * command governance gates. Mirrors `SHELL_TOOL_NAMES` in
 * `toolExecution/serverRuntimes/cloudSandbox.ts` (kept as a separate literal
 * rather than a shared import — that module belongs to the Agent tool-call
 * layer, this one gates every caller of `SandboxMiddlewareService`).
 * `executeCode` runs the `code` field (python/javascript/typescript, default
 * python); `runCommand`/`execScript` run the `command` field.
 */
const GOVERNED_SHELL_TOOL_NAMES = new Set(['execScript', 'runCommand', 'executeCode']);

/** `readLocalFile` is the legacy name still used by ComputerRuntime and remote sandboxes. */
const READ_FILE_TOOL_NAMES = new Set(['readFile', 'readLocalFile']);

export class SandboxMiddlewareService implements SandboxService {
  readonly capabilities: SandboxProviderCapabilities;
  readonly kind: SandboxProviderKind;

  private environmentInitialized = false;
  /** What applying the environment said, until a shell result carries it. */
  private pendingEnvironmentReport: string | undefined;
  private filesInitialized = false;

  constructor(
    private readonly provider: SandboxProvider,
    private readonly options: SandboxServiceOptions,
  ) {
    this.capabilities = provider.capabilities;
    this.kind = provider.kind;
  }

  /**
   * The single collection point for every caller of the sandbox provider —
   * the Agent tool-call path (`toolExecution/serverRuntimes/cloudSandbox.ts`)
   * and the front-end "run" path (`routers/tools/market.ts` →
   * `execInSandboxHandler`) both end up here. Command governance is gated at
   * this chokepoint rather than upstream so both paths, and all code-execution
   * tool names (`runCommand`/`execScript`/`executeCode`), are covered by one
   * check — and so a new sandbox shell tool is covered automatically.
   *
   * `checkCommand`/`logCommandExecution` no-op without touching governance
   * rules or logs when the `command_governance` flag is off for the user. An unreadable flag does
   * not run the command (`GOVERNANCE_UNAVAILABLE`); rule-lookup errors also prevent execution
   * — see `services/governance/policyGate.ts`.
   */
  async callTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SandboxCallToolResult> {
    const report = await this.ensureEnvironmentInitialized();
    if (report) this.pendingEnvironmentReport = report;
    await this.ensureFilesInitialized();

    if (READ_FILE_TOOL_NAMES.has(toolName) && typeof params.path === 'string') {
      const mimeType = getLocalImageMimeType(params.path);
      if (mimeType) return this.readSandboxImageFile(params.path, mimeType);
    }

    const result = await this.callGovernedTool(toolName, params);

    // Held until a shell result can carry it: a first call that lists or
    // reads files has no output to put it in, and dropping it would hide a
    // failed setup from the rest of the conversation.
    const pending = this.pendingEnvironmentReport;
    if (!pending || !SHELL_TOOLS.has(toolName)) return result;
    this.pendingEnvironmentReport = undefined;

    return withEnvironmentReport(toolName, result, pending);
  }

  /**
   * Apply the topic's environment to the working directory the first time this
   * service instance is used: clone its repository and run its setup there.
   *
   * The command itself decides whether to run: only an empty directory is
   * initialized, so a temporary sandbox is initialized each time it starts
   * empty and a folder on the drive once. Best-effort: a failure is reported,
   * never thrown, and the tool call it precedes still runs.
   *
   * Returns what the run printed when it did something, for the next shell
   * result to carry; nothing when the directory was already initialized.
   */
  private async ensureEnvironmentInitialized(): Promise<string | undefined> {
    if (this.environmentInitialized) return;
    this.environmentInitialized = true;

    const init = this.options.sandboxInitialization;
    if (!init || !this.provider.capabilities.shell) return;

    try {
      const result = await callTenantSandboxTool(
        this.provider,
        'runCommand',
        {
          command: buildSandboxEnvironmentInitCommand(init),
          timeout: SANDBOX_ENVIRONMENT_INIT_TIMEOUT_MS,
        },
        this.options,
      );
      const stdout = (result.result as { stdout?: string } | null | undefined)?.stdout;
      // The command always exits cleanly, so a failed call that printed
      // nothing never reached the sandbox: said so, not passed off as a
      // folder that was already initialized.
      if (!environmentInitRan(stdout)) {
        return result.success ? undefined : environmentInitUnreachable(init.name);
      }

      log(
        'Environment %s applied for topic %s: success=%s',
        init.environmentId,
        this.options.topicId,
        result.success,
      );

      return environmentInitReport(stdout) || undefined;
    } catch (error) {
      log('Environment init failed for topic %s: %O', this.options.topicId, error);

      return environmentInitUnreachable(init.name);
    }
  }

  /**
   * Sandbox counterpart of `readLocalImageFile`: remote readers decode files as
   * UTF-8, so image bytes either fail or come back as mojibake. Upload the
   * image through the export pipeline instead and return the same
   * `{ isImage, imageUrl, imageFileId }` shape the device path produces, which
   * ComputerRuntime routes to `state.images`. Failures degrade to an
   * `[Image: name]` placeholder rather than failing the read.
   */
  private async readSandboxImageFile(
    filePath: string,
    mimeType: string,
  ): Promise<SandboxCallToolResult> {
    const filename = posixPath.basename(filePath);
    const buildResult = (content: string, extra: Record<string, unknown> = {}) => ({
      result: { content, fileType: mimeType, filename, isImage: true, ...extra },
      success: true,
    });

    if (!this.provider.capabilities.exportFile || !this.options.fileService) {
      return buildResult(
        `[Image: ${filename}] (upload unavailable — this sandbox cannot export files; the model cannot view this image)`,
      );
    }

    const exported = await this.exportAndUploadFile(filePath, filename, {
      // A visitor's image preview gets the same share provenance the upload
      // path stamps, so it never surfaces in the creator's library while
      // `/f/:id` stays openable.
      ...(this.options.agentShareVisitor
        ? { metadata: { agentShare: this.options.agentShareVisitor } }
        : {}),
      storageName: `${randomUUID()}-${filename}`,
    });

    if (!exported.success) {
      // Auth failures must stay failed so the execInSandbox route re-prompts
      // for Market auth; access-denied refusals must stop the run. Neither may
      // be softened into the upload-unavailable placeholder.
      if (isSandboxAuthError(exported.error) || isSandboxAccessDeniedError(exported.error)) {
        return { error: exported.error, result: null, success: false };
      }

      return buildResult(
        `[Image: ${filename}] (upload unavailable — ${exported.error?.message || 'export failed'}; the model cannot view this image)`,
      );
    }

    if (!exported.url) {
      return buildResult(
        `[Image: ${filename}] (upload unavailable — export failed; the model cannot view this image)`,
      );
    }

    if (exported.size !== undefined && exported.size > MAX_IMAGE_READ_BYTES) {
      return buildResult(
        `Error: Image file is too large to preview (${exported.size} bytes, limit ${MAX_IMAGE_READ_BYTES}).`,
      );
    }

    return buildResult(`[Image: ${filename}]`, {
      fileType: exported.mimeType?.startsWith('image/') ? exported.mimeType : mimeType,
      imageFileId: exported.fileId,
      imageUrl: exported.url,
    });
  }

  /**
   * Command governance for the code-execution tool names; every other tool, and
   * every governed call that is allowed, goes to the provider through the
   * tenant work receipt (`callTenantSandboxTool`).
   */
  private async callGovernedTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SandboxCallToolResult> {
    const { serverDB, userId } = this.options;

    if (!GOVERNED_SHELL_TOOL_NAMES.has(toolName)) {
      return callTenantSandboxTool(this.provider, toolName, params, this.options);
    }

    const ctx = {
      apiName: toolName,
      // The exact payload that will execute: `executeCode` runs `code` (never
      // the sibling `command` field, which an attacker can attach as a decoy).
      commandText:
        toolName === 'executeCode'
          ? typeof params?.code === 'string'
            ? params.code
            : JSON.stringify(params ?? {})
          : typeof params?.command === 'string'
            ? params.command
            : JSON.stringify(params ?? {}),
      executionTarget: 'sandbox',
      toolIdentifier: CloudSandboxIdentifier,
      userId,
    } satisfies CommandGovernanceContext;

    let decision;
    try {
      if (!userId) throw new GovernanceUnavailableError();
      if (!serverDB) {
        if (await isGovernanceEnabled(userId)) throw new GovernanceUnavailableError();
        return callTenantSandboxTool(this.provider, toolName, params, this.options);
      }
      decision = await checkCommand(ctx, serverDB);
    } catch (error) {
      // Governance could not be evaluated: nothing runs, and it is not reported as a rule
      // denial (COMMAND_BLOCKED tells the model never to retry).
      if (!(error instanceof GovernanceUnavailableError)) throw error;
      log('Command governance unavailable for %s', toolName);
      return {
        error: { message: GOVERNANCE_UNAVAILABLE_MESSAGE, name: 'GOVERNANCE_UNAVAILABLE' },
        result: null,
        success: false,
      };
    }

    if (!decision.allowed) {
      try {
        await logCommandExecution(ctx, { blocked: true, matchedRuleId: decision.ruleId }, serverDB);
      } catch (auditError) {
        console.error('[governance] Failed to record blocked-command audit log: %O', auditError);
      }

      return {
        error: {
          message: COMMAND_BLOCKED_MESSAGE,
          name: 'COMMAND_BLOCKED',
        },
        result: null,
        success: false,
      };
    }

    const startedAt = Date.now();
    const result = await callTenantSandboxTool(this.provider, toolName, params, this.options);

    try {
      await logCommandExecution(
        ctx,
        {
          blocked: false,
          durationMs: Date.now() - startedAt,
          errorMessage: result.error?.message,
          success: result.success,
        },
        serverDB,
      );
    } catch (auditError) {
      console.error('[governance] Failed to record command execution audit log: %O', auditError);
    }

    return result;
  }

  /**
   * Sync the files the user uploaded in this topic/session into the sandbox the
   * first time this service instance is used. Best-effort: any failure is
   * swallowed so it never blocks the actual tool call.
   *
   * The downloaded command is guarded by an in-sandbox marker file, which is the
   * single source of truth for idempotency: it is a cheap no-op once synced, and
   * if the sandbox session is recycled the marker disappears so the next call
   * re-syncs automatically. We intentionally do NOT cache the "done" state out of
   * band (e.g. in Redis), because that could skip the re-sync after a recycle and
   * leave the agent believing files exist when /mnt/data is empty.
   */
  private async ensureFilesInitialized(): Promise<void> {
    if (this.filesInitialized) return;
    this.filesInitialized = true;

    const { fileService, serverDB, topicId, userId } = this.options;
    if (!serverDB || !fileService || !topicId || !userId) return;
    if (!this.provider.capabilities.shell) return;

    try {
      const fileModel = new FileModel(serverDB, userId);
      const files = selectSandboxInitFiles(await fileModel.findFilesToInitInSandbox(topicId));

      if (files.length === 0) return;

      const downloads = (
        await Promise.all(
          files.map(async (file): Promise<SandboxInitDownload | null> => {
            const url = await fileService
              .createCachedPreSignedUrlForPreview(file.url)
              .catch(() => '');
            return url ? { name: file.name, url } : null;
          }),
        )
      ).filter((item): item is SandboxInitDownload => item !== null);

      if (downloads.length === 0) return;

      const command = buildSandboxFilesInitCommand(downloads);
      const result = await callTenantSandboxTool(this.provider, 'runCommand', {
        command,
        timeout: SANDBOX_INIT_TIMEOUT_MS,
      });

      log(
        'Sandbox file init for topic %s: %d files, success=%s',
        topicId,
        downloads.length,
        result.success,
      );
    } catch (error) {
      log('Sandbox file init failed for topic %s: %O', topicId, error);
    }
  }

  async exportAndUploadFile(
    path: string,
    filename: string,
    options?: {
      /** Server-owned file-record metadata, e.g. Agent Share provenance. */
      metadata?: Record<string, unknown>;
      storageName?: string;
    },
  ): Promise<SandboxExportFileResult> {
    const { fileService, topicId } = this.options;

    if (!fileService) {
      return {
        error: { message: 'fileService is required for sandbox file export' },
        filename,
        success: false,
      };
    }

    // The object's storage key uses `storageName` when provided so callers can
    // guarantee a collision-proof, immutable object per (operation, path); the
    // file record's display `name` always stays the user-facing `filename`, so a
    // download never surfaces the mangled key. Defaults to `filename` for the
    // common case where display name and key are the same.
    const storageName = options?.storageName ?? filename;

    log(
      'Exporting file: %s (key: %s) from path: %s, topicId: %s',
      filename,
      storageName,
      path,
      topicId,
    );

    try {
      const now = Date.now();
      const today = new Date(now).toISOString().split('T')[0];
      const key = `code-interpreter-exports/${today}/${topicId}/${storageName}`;
      const upload = await fileService.createPreSignedUpload(key);

      const exported = await this.provider.exportFileToUploadUrl({
        filename,
        path,
        uploadHeaders: upload.headers,
        uploadUrl: upload.url,
      });

      if (!exported.success) {
        return {
          error: {
            ...exported.error,
            message: exported.error?.message || 'Failed to export file from sandbox',
          },
          filename,
          success: false,
        };
      }

      const metadata = await fileService.getFileMetadata(key);
      const fileSize = metadata.contentLength;
      const mimeType =
        metadata.contentType ||
        exported.mimeType ||
        String(exported.result?.mimeType || '') ||
        String(exported.result?.mime_type || '') ||
        'application/octet-stream';
      const fileHash = sha256(key + now.toString());

      const { fileId, url } = await fileService.createFileRecord({
        fileHash,
        fileType: mimeType,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        name: filename,
        size: fileSize,
        url: key,
      });

      return {
        fileId,
        filename,
        mimeType,
        size: fileSize,
        success: true,
        url,
      };
    } catch (error) {
      log('Error exporting file: %O', error);

      return {
        error: { message: (error as Error).message },
        filename,
        success: false,
      };
    }
  }
}

export const normalizeSandboxCommandResult = (
  result: SandboxCallToolResult,
): SandboxCommandResult => {
  const sessionState = result.sessionExpiredAndRecreated
    ? { sessionExpiredAndRecreated: true }
    : {};
  if (!result.success) {
    // The tool call failed before (or without) producing a shell observation:
    // propagate the upstream error kind (governance denial/outage, transport
    // failure) so callers keep the deny-vs-unavailable-vs-retry distinction.
    // There is deliberately no `exitCode`: 0 and 1 are real shell statuses, so
    // synthesizing either would claim an execution that never happened.
    return {
      ...sessionState,
      error: result.error || { message: 'Command execution failed' },
      output: '',
      success: false,
    };
  }

  const raw = result.result || {};
  const rawExitCode = raw.exitCode ?? raw.exit_code;
  const exitCode = typeof rawExitCode === 'number' ? rawExitCode : undefined;
  // A background/observation-window result can report liveness explicitly; a
  // missing exit code without that flag still means "not finished yet" per the
  // provider contract, so it must not be reported as exit 0.
  const running = raw.running === true || raw.isRunning === true;
  const output = String(raw.stdout || raw.output || '');
  const stderr = raw.stderr === undefined ? undefined : String(raw.stderr);
  const shellId =
    typeof raw.commandId === 'string'
      ? raw.commandId
      : typeof raw.shell_id === 'string'
        ? raw.shell_id
        : undefined;
  const success =
    typeof raw.success === 'boolean'
      ? raw.success
      : running || exitCode === undefined || exitCode === 0;

  return {
    ...sessionState,
    ...(exitCode !== undefined && !running && { exitCode }),
    output,
    ...(shellId && { shellId }),
    stderr,
    success,
  };
};

const SHELL_TOOLS = new Set(['execScript', 'runCommand']);

/**
 * What the conversation is told when the initializer could not be run at all
 * — the sandbox did not answer — so a command that follows in an empty folder
 * is not mistaken for one in the checkout. Nothing was recorded, so the next
 * call tries again.
 */
const environmentInitUnreachable = (name: string) =>
  `The environment "${name}" could not be applied: the sandbox did not respond. It will be tried again on the next command.`;

/**
 * The first shell result after an environment was applied, with what applying
 * it said in front — so the conversation sees why its directory now holds a
 * checkout, or why it does not. Other tools' results are left as they are:
 * they have no output to put it in.
 */
const withEnvironmentReport = (
  toolName: string,
  result: SandboxCallToolResult,
  report: string,
): SandboxCallToolResult => {
  const payload = result.result as { stdout?: string } | null | undefined;
  if (!SHELL_TOOLS.has(toolName) || !payload || typeof payload !== 'object') return result;

  return {
    ...result,
    result: { ...payload, stdout: `[environment] ${report}\n\n${payload.stdout ?? ''}` },
  };
};
