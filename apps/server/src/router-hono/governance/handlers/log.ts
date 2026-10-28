import type { Context } from 'hono';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import {
  GovernanceUnavailableError,
  isGovernanceEnabled,
  logCommandExecution,
} from '@/server/services/governance';

import { governanceUnavailable } from './unavailable';

const LogBodySchema = z.object({
  apiName: z.string().min(1),
  commandText: z.string(),
  deviceId: z.string().optional(),
  executionTarget: z.enum(['local', 'device', 'sandbox']),
  outcome: z.object({
    blocked: z.boolean(),
    durationMs: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
    matchedRuleId: z.string().optional(),
    success: z.boolean().optional(),
  }),
  toolIdentifier: z.string().min(1),
  userId: z.string().min(1),
});

/**
 * POST /api/governance/log — the sandbox execution service reports the
 * outcome of a command it ran (or blocked) so the audit trail covers
 * execution that happens entirely outside this process.
 *
 * No response body (`204`) — this is a fire-and-forget write, same shape as
 * `POST /api/agent/tool-result`. No-ops (still `204`) when governance is
 * disabled for the user, matching `logCommandExecution`'s own short-circuit. When the flag cannot be
 * read it is unknown whether the entry should exist, so the caller gets 503 `GOVERNANCE_UNAVAILABLE`
 * instead of a 204 that claims it was handled.
 */
export async function log(c: Context): Promise<Response> {
  let parsed;
  try {
    parsed = LogBodySchema.safeParse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  try {
    if (!(await isGovernanceEnabled(parsed.data.userId))) {
      return c.body(null, 204);
    }
  } catch (error) {
    if (error instanceof GovernanceUnavailableError) return governanceUnavailable(c);
    throw error;
  }

  const { outcome, ...ctx } = parsed.data;
  const serverDB = await getServerDB();
  await logCommandExecution(ctx, outcome, serverDB);

  return c.body(null, 204);
}
