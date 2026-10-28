/**
 * Market telemetry wire contract v1 (the parts the CPC side owns): event
 * identity, and the shape of the execution-completion snapshot every report is
 * built from. Pure and free of Node-only imports, because the desktop/web
 * client builds events too.
 */
export type TelemetryEventType =
  'activate' | 'add' | 'call' | 'chat' | 'click' | 'install' | 'uninstall';

export type TelemetryResourceType = 'agent' | 'agentGroup' | 'plugin' | 'skill';

/** `eventId` is 1..255 characters on the wire. */
export const TELEMETRY_EVENT_ID_MAX_LENGTH = 255;

export class TelemetryEventIdError extends Error {
  constructor(reason: string) {
    super(`TELEMETRY_EVENT_ID_INVALID:${reason}`);
    this.name = 'TelemetryEventIdError';
  }
}

export interface TelemetryExecutionIdentity {
  /**
   * 1-based number of this try as the execution scheduler counts it (the
   * runtime's tool retry loop). A network retry of the *report* is not a new
   * attempt and keeps the number.
   */
  attempt: number;
  eventType: TelemetryEventType;
  /** Stable identity of the execution: tool call id, operation id, client invocation id. */
  executionId: string;
}

/** `v1:<eventType>:<executionId>:<attempt>`. */
export const buildTelemetryEventId = ({
  attempt,
  eventType,
  executionId,
}: TelemetryExecutionIdentity): string => {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TelemetryEventIdError('attempt');
  if (!executionId) throw new TelemetryEventIdError('executionId');

  const eventId = `v1:${eventType}:${executionId}:${attempt}`;
  if (eventId.length > TELEMETRY_EVENT_ID_MAX_LENGTH) throw new TelemetryEventIdError('length');

  return eventId;
};

/**
 * One execution identity out of several stable ids (`operationId`,
 * `toolCallId`). Parts are escaped so two different tuples never compose to the
 * same string: `a:b` + `c` is not `a` + `b:c`.
 */
export const composeExecutionId = (...parts: string[]): string =>
  parts.map((part) => part.replaceAll('%', '%25').replaceAll(':', '%3A')).join(':');

/** The fixed facts about one finished execution. Nothing here changes on a retry. */
export interface CompletedTelemetryExecution {
  attempt: number;
  /** Whole milliseconds, taken from a monotonic clock at the completion boundary. */
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  eventId: string;
  eventType: TelemetryEventType;
  /** ISO 8601 (UTC) instant the execution completed. */
  occurredAt: string;
  success: boolean;
}
