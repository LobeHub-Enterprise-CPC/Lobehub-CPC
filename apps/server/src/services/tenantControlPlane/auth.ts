import { createHash, timingSafeEqual } from 'node:crypto';

import { CONTROL_PLANE_ACTIONS, type ControlPlaneAction } from './contracts';

/**
 * Service-token authorisation for the control plane (spec FR-CP-02).
 *
 * Grants come only from server env: `LOBEHUB_CONTROL_PLANE_TOKEN` gets every
 * action; `LOBEHUB_CONTROL_PLANE_TOKENS_JSON` (`[{ token, actions }]`) splits
 * least-privilege tokens. Nothing a caller says about itself takes part.
 */

const MIN_TOKEN_LENGTH = 32;

interface Grant {
  actions: ReadonlySet<ControlPlaneAction>;
  digest: Buffer;
}

export interface ControlPlaneAuthEnv {
  LOBEHUB_CONTROL_PLANE_TOKEN?: string;
  LOBEHUB_CONTROL_PLANE_TOKENS_JSON?: string;
}

const digest = (token: string) => createHash('sha256').update(token).digest();

const isAction = (value: unknown): value is ControlPlaneAction =>
  CONTROL_PLANE_ACTIONS.includes(value as ControlPlaneAction);

/**
 * Parses the grants. Misconfiguration throws, so a deploy with a short token or
 * a typo in an action name fails loudly instead of quietly denying Console.
 * Returns `null` when neither variable is set (the endpoints answer 503).
 */
export const parseControlPlaneGrants = (env: ControlPlaneAuthEnv): Grant[] | null => {
  const grants: Grant[] = [];

  const push = (token: unknown, actions: readonly unknown[]) => {
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH)
      throw new Error(`control-plane token must be at least ${MIN_TOKEN_LENGTH} characters`);
    const unknown = actions.filter((a) => !isAction(a));
    if (unknown.length > 0 || actions.length === 0)
      throw new Error('control-plane token grants must list known actions');
    grants.push({ actions: new Set(actions as ControlPlaneAction[]), digest: digest(token) });
  };

  if (env.LOBEHUB_CONTROL_PLANE_TOKEN) push(env.LOBEHUB_CONTROL_PLANE_TOKEN, CONTROL_PLANE_ACTIONS);

  if (env.LOBEHUB_CONTROL_PLANE_TOKENS_JSON) {
    const parsed: unknown = JSON.parse(env.LOBEHUB_CONTROL_PLANE_TOKENS_JSON);
    if (!Array.isArray(parsed))
      throw new Error('LOBEHUB_CONTROL_PLANE_TOKENS_JSON must be an array');
    for (const entry of parsed) {
      const { token, actions } = (entry ?? {}) as { actions?: unknown; token?: unknown };
      push(token, Array.isArray(actions) ? actions : []);
    }
  }

  return grants.length > 0 ? grants : null;
};

/**
 * True when the `Authorization` header carries a token granted `action`.
 * Every grant is compared, in constant time on fixed-length digests, so the
 * response time says nothing about which token or how much of it matched.
 */
export const isAuthorized = (
  grants: readonly Grant[],
  authorization: string | undefined,
  action: ControlPlaneAction,
): boolean => {
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!match) return false;
  const presented = digest(match[1]);

  let allowed = false;
  for (const grant of grants) {
    if (timingSafeEqual(grant.digest, presented) && grant.actions.has(action)) allowed = true;
  }
  return allowed;
};
