import { DiscoveryError } from './errors';

export const DISCOVERY_MAX_BODY_BYTES = 1024;

export const isJsonContentType = (request: Request) =>
  request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json';

/**
 * Reads a small JSON body with a hard byte cap while honouring the request deadline. A wrong
 * content type or malformed JSON is 400 INVALID_REQUEST; `onTooLarge` supplies the error for an
 * oversize body so each entry point keeps its own status.
 */
export const readDiscoveryJsonBody = async (
  request: Request,
  signal: AbortSignal,
  onTooLarge: () => Error,
): Promise<unknown> => {
  if (!isJsonContentType(request)) throw new DiscoveryError('INVALID_REQUEST', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new DiscoveryError('INVALID_REQUEST', 400);
  const abort = () => {
    void reader.cancel().catch(() => console.warn('TENANT_DISCOVERY_BODY_CANCEL_FAILED'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    let length = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > DISCOVERY_MAX_BODY_BYTES) {
        // A failing cancel must not replace the oversize error.
        await reader.cancel().catch(() => console.warn('TENANT_DISCOVERY_BODY_CANCEL_FAILED'));
        throw onTooLarge();
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DiscoveryError('INVALID_REQUEST', 400);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
};
