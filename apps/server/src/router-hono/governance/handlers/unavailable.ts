import type { Context } from 'hono';

/**
 * The `command_governance` flag could not be read: a server error the caller denies on and may
 * retry, never a verdict about the command.
 */
export const governanceUnavailable = (c: Context): Response => {
  c.header('Retry-After', '1');
  return c.json({ error: 'GOVERNANCE_UNAVAILABLE' }, 503);
};
