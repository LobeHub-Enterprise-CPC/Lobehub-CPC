import type { Context } from 'hono';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import {
  checkCommand,
  GovernanceUnavailableError,
  isGovernanceEnabled,
} from '@/server/services/governance';

import { governanceUnavailable } from './unavailable';

const CheckBodySchema = z.object({
  apiName: z.string().min(1),
  commandText: z.string(),
  deviceId: z.string().optional(),
  executionTarget: z.enum(['local', 'device', 'sandbox']),
  toolIdentifier: z.string().min(1),
  userId: z.string().min(1),
});

/**
 * POST /api/governance/check — the sandbox execution service (and any other
 * non-CPC-server dispatcher) calls this before running a command it received,
 * so a governance rule applies uniformly regardless of which process actually
 * spawns the shell.
 *
 * Response: `{ allowed: boolean, ruleId?: string }`, or 503 `{ error: 'GOVERNANCE_UNAVAILABLE' }`
 * when the `command_governance` flag cannot be read. `allowed:true` is only ever the answer for a
 * flag that is explicitly off or a command no rule denies; a caller treats every non-2xx as a
 * refusal. The outage is not reported as `{ allowed: false }`: that is a policy verdict the model is
 * told never to retry.
 *
 * The rule evaluation itself (`checkCommand`) keeps its fail-open behavior for lookup errors.
 */
export async function check(c: Context): Promise<Response> {
  let parsed;
  try {
    parsed = CheckBodySchema.safeParse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  }

  // Mirror the in-process chokepoint's short-circuit: no DB connection is
  // opened here when the feature is off for the user, even though a caller may
  // hit this endpoint unconditionally for every command it dispatches.
  try {
    if (!(await isGovernanceEnabled(parsed.data.userId))) {
      return c.json({ allowed: true }, 200);
    }

    const serverDB = await getServerDB();
    const decision = await checkCommand(parsed.data, serverDB);

    return c.json(decision, 200);
  } catch (error) {
    if (error instanceof GovernanceUnavailableError) return governanceUnavailable(c);
    throw error;
  }
}
