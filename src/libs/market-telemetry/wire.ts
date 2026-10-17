import {
  type CompletedTelemetryExecution,
  TELEMETRY_EVENT_ID_MAX_LENGTH,
  TelemetryEventIdError,
  type TelemetryEventType,
  type TelemetryResourceType,
} from './event';
import { redactTelemetryText, sanitizeTelemetryMetadata } from './redact';

/**
 * One report, ready to send: the endpoint and the request body, fixed from the
 * completed execution. Nothing about delivery lives here — no token, no
 * arrival time — so delivering it again (a network retry) sends the same bytes
 * and Market sees the same event.
 */
export interface TelemetryReport {
  readonly body: Readonly<Record<string, unknown>>;
  readonly eventId: string;
  readonly eventType: TelemetryEventType;
  readonly kind: 'interaction' | 'pluginInstall' | 'toolCall';
  readonly path:
    | '/api/v1/plugins/report/call'
    | '/api/v1/plugins/report/installation'
    | '/api/v1/telemetry/events';
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const compact = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;

const clip = (value: string | undefined, max: number) => value?.slice(0, max);

const identity = (completed: CompletedTelemetryExecution) => ({
  eventId: completed.eventId,
  occurredAt: completed.occurredAt,
});

const failure = (completed: CompletedTelemetryExecution) =>
  completed.success ? {} : { errorCode: completed.errorCode, errorMessage: completed.errorMessage };

export interface ToolCallDescriptor {
  appVersion?: string;
  command?: string;
  customPluginInfo?: { avatar?: string; description?: string; name?: string };
  identifier: string;
  isCustomPlugin?: boolean;
  /** `cloud`, `http`, `stdio`, … */
  mcpType?: string;
  methodName: string;
  platform?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
  sessionId?: string;
  traceId?: string;
  version?: string;
  /** The call was tunnelled to the user's device. */
  viaDevice?: boolean;
}

/**
 * `POST /api/v1/plugins/report/call`. What the tool was given and what it
 * returned never goes in; the sizes do.
 */
export const buildToolCallReport = (
  completed: CompletedTelemetryExecution,
  descriptor: ToolCallDescriptor,
): TelemetryReport =>
  deepFreeze({
    body: compact({
      ...identity(completed),
      callDurationMs: completed.durationMs,
      customPluginInfo: descriptor.customPluginInfo && compact({ ...descriptor.customPluginInfo }),
      identifier: descriptor.identifier,
      isCustomPlugin: descriptor.isCustomPlugin,
      metadata: sanitizeTelemetryMetadata({
        appVersion: descriptor.appVersion,
        command: descriptor.command,
        mcpType: descriptor.mcpType,
        viaDevice: descriptor.viaDevice,
      }),
      methodName: descriptor.methodName,
      methodType: 'tool',
      platform: clip(descriptor.platform, 50),
      requestSizeBytes: descriptor.requestSizeBytes,
      responseSizeBytes: descriptor.responseSizeBytes,
      sessionId: descriptor.sessionId,
      success: completed.success,
      traceId: descriptor.traceId,
      version: descriptor.version || 'unknown',
      ...failure(completed),
    }),
    eventId: completed.eventId,
    eventType: completed.eventType,
    kind: 'toolCall',
    path: '/api/v1/plugins/report/call',
  });

export interface PluginInstallDescriptor {
  identifier: string;
  /** Tool/prompt/resource listing, kept by Market as a log snapshot. */
  manifest?: unknown;
  metadata?: Record<string, unknown>;
  platform?: string;
  userAgent?: string;
  version: string;
}

/**
 * `POST /api/v1/plugins/report/installation`. The connection parameters the
 * user installed with (headers, env) carry their credentials and are not sent.
 */
export const buildPluginInstallReport = (
  completed: CompletedTelemetryExecution,
  descriptor: PluginInstallDescriptor,
): TelemetryReport =>
  deepFreeze({
    body: compact({
      ...identity(completed),
      identifier: descriptor.identifier,
      installDurationMs: completed.durationMs,
      manifest: descriptor.manifest,
      metadata: sanitizeTelemetryMetadata(descriptor.metadata),
      platform: clip(descriptor.platform, 50),
      success: completed.success,
      userAgent: descriptor.userAgent,
      version: descriptor.version,
      ...failure(completed),
    }),
    eventId: completed.eventId,
    eventType: completed.eventType,
    kind: 'pluginInstall',
    path: '/api/v1/plugins/report/installation',
  });

export interface InteractionDescriptor {
  identifier: string;
  metadata?: Record<string, unknown>;
  platform?: string;
  resourceType: TelemetryResourceType;
  source?: string;
  version?: string;
}

/** `POST /api/v1/telemetry/events`: install, uninstall, activate, click, add, chat. */
export const buildInteractionReport = (
  completed: CompletedTelemetryExecution,
  descriptor: InteractionDescriptor,
): TelemetryReport =>
  deepFreeze({
    body: compact({
      ...identity(completed),
      durationMs: completed.durationMs,
      eventType: completed.eventType,
      identifier: descriptor.identifier,
      metadata: sanitizeTelemetryMetadata(descriptor.metadata),
      platform: clip(descriptor.platform, 50),
      resourceType: descriptor.resourceType,
      source: clip(descriptor.source, 50),
      success: completed.success,
      version: descriptor.version,
      ...(completed.success ? {} : { errorCode: completed.errorCode }),
    }),
    eventId: completed.eventId,
    eventType: completed.eventType,
    kind: 'interaction',
    path: '/api/v1/telemetry/events',
  });

/** What a client sends back to the server to be reported: the fixed facts, nothing derived. */
export interface TelemetryEnvelope {
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  eventId: string;
  occurredAt: string;
  success: boolean;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Rebuild the completed execution a client reported, validating but not
 * recomputing anything: the client's completion boundary fixed these facts.
 */
export const completedFromEnvelope = (
  eventType: TelemetryEventType,
  envelope: TelemetryEnvelope,
): CompletedTelemetryExecution => {
  const { durationMs, eventId, occurredAt, success } = envelope;

  if (!eventId || eventId.length > TELEMETRY_EVENT_ID_MAX_LENGTH) {
    throw new TelemetryEventIdError('length');
  }
  if (!ISO_WITH_ZONE.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    throw new TypeError('TELEMETRY_OCCURRED_AT_INVALID');
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new TypeError('TELEMETRY_DURATION_INVALID');
  }

  const attempt = Number(eventId.split(':').at(-1));

  return Object.freeze({
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    durationMs: Math.round(durationMs),
    ...(success
      ? {}
      : {
          errorCode: clip(envelope.errorCode, 100) ?? 'CALL_FAILED',
          ...(envelope.errorMessage
            ? { errorMessage: redactTelemetryText(envelope.errorMessage) }
            : {}),
        }),
    eventId,
    eventType,
    occurredAt,
    success,
  });
};
