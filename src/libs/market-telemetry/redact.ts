/**
 * What may leave this process as telemetry text. Execution inputs and outputs
 * are never sent; the only free text is an error message and a few metadata
 * values, and both go through here first.
 */
export const TELEMETRY_ERROR_MESSAGE_MAX_LENGTH = 500;
const TELEMETRY_METADATA_VALUE_MAX_LENGTH = 200;

// Keys that name a secret, or the data an execution handled (process output,
// request bodies, connection parameters): not telemetry.
const SECRET_KEY =
  /token|secret|passw|authorization|api[-_]?key|cookie|credential|session|log$|output|input|std(?:out|err)|env|header|body|payload|param|args/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\bBasic\s+[\w+/=-]{8,}/gi,
  /\bsk-[\w-]{8,}/g,
  // key=value / key: value pairs whose key names a secret
  /\b[\w-]*(?:token|secret|passw(?:or)?d|api[-_]?key|authorization|cookie)[\w-]*\s*[:=]\s*["']?[^\s"',;&]+/gi,
  // credentials inside a URL: scheme://user:pass@host
  /\b([a-z][\d+.a-z-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];

export const redactTelemetryText = (
  text: string,
  maxLength: number = TELEMETRY_ERROR_MESSAGE_MAX_LENGTH,
): string => {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, scheme?: string) =>
      scheme && match.includes('@') ? `${scheme}[redacted]@` : '[redacted]',
    );
  }
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
};

/**
 * Flat metadata only: scalar values, no secret-looking keys, bounded strings.
 * Anything else (nested objects, arrays, request bodies) is dropped, not
 * summarised.
 */
export const sanitizeTelemetryMetadata = (
  metadata: Record<string, unknown> | undefined | null,
): Record<string, boolean | number | string> | undefined => {
  if (!metadata || typeof metadata !== 'object') return undefined;

  const safe: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === 'string') {
      safe[key] = redactTelemetryText(value, TELEMETRY_METADATA_VALUE_MAX_LENGTH);
    } else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      safe[key] = value;
    }
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
};
