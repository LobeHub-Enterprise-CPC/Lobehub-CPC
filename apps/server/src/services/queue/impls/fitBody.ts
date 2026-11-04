/**
 * How much a single string may keep, tried in order until the WHOLE body
 * measures under budget. One pass at a generous limit is not enough: a body
 * can also be oversized through fragmentation — the MCP contract keeps every
 * raw content block in `state`, so hundreds of blocks each shorter than the
 * limit survive an untouched pass and still add up past the quota. Each rung
 * re-clamps the original body, so the notices never nest.
 */
const OVERSIZED_STRING_KEEP_LADDER = [25_000, 4000, 512, 0];

/**
 * Shrink a too-large message body by clamping every string past `keep`,
 * depth-first. Strings are the only thing that can run away here — tool
 * results and error messages carrying raw command output — so clamping them
 * recovers the body while keeping its shape intact for the worker that
 * receives it.
 */
const clampOversizedStrings = (value: unknown, keep: number): unknown => {
  if (typeof value === 'string') {
    if (value.length <= keep) return value;
    const omitted = value.length - keep;

    return `${value.slice(0, keep)}\n\n[Truncated: ${omitted.toLocaleString()} characters omitted so the step could be scheduled. Original length: ${value.length.toLocaleString()} characters]`;
  }

  if (Array.isArray(value)) return value.map((entry) => clampOversizedStrings(entry, keep));

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        clampOversizedStrings(entry, keep),
      ]),
    );
  }

  return value;
};

export interface BodyQuota {
  budgetBytes: number;
  limitBytes: number;
  /** Bytes the transport carries for a candidate body. */
  measure: (body: unknown) => number;
  transport: string;
}

/**
 * Keep a step schedulable when its body outgrew the transport's message quota:
 * clamp its strings rather than let the publish 500 and
 * take the whole operation down. The step still runs — it just sees a
 * truncated copy of whatever ran away. Clamping tightens until the body
 * MEASURES under budget, so a body that is oversized through many mid-sized
 * strings is handled too, not only one runaway blob.
 */
export const fitBodyToQuota = <T extends { body: unknown }>(
  request: T,
  operationId: string,
  quota: BodyQuota,
): T => {
  const size = quota.measure(request.body);
  if (size <= quota.budgetBytes) return request;

  for (const keep of OVERSIZED_STRING_KEEP_LADDER) {
    const body = clampOversizedStrings(request.body, keep);
    const clampedBytes = quota.measure(body);
    if (clampedBytes > quota.budgetBytes) continue;

    console.warn(
      JSON.stringify({
        bytes: size,
        clampedBytes,
        event: 'agent.queue.oversized_message_clamped',
        limitBytes: quota.limitBytes,
        operationId,
        stringKeep: keep,
      }),
    );

    return { ...request, body };
  }

  // Unreachable through strings — the last rung drops every string to a
  // notice. Getting here means the body is huge in its non-string structure,
  // which no truncation can fix; fail with something diagnosable instead of
  // an opaque transport error.
  throw new Error(
    `${quota.transport} message for operation ${operationId} is ${size} bytes and cannot be reduced under the ${quota.limitBytes} byte quota`,
  );
};
