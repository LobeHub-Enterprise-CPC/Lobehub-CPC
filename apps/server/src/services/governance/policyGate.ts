import type { LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';

import { evaluateFeatureFlag, FeatureFlagsSchema } from '@/config/featureFlags';
import { getServerFeatureFlagsFromRuntimeConfig } from '@/server/featureFlags';

import { listEnabledRulesForTarget } from './rulesRepository';
import type {
  CommandGovernanceContext,
  CommandGovernanceDecision,
  CommandGovernancePatternType,
} from './types';

const log = debug('lobe-server:governance:policy-gate');

/**
 * The tool-result message shown to the model when `checkCommand` denies a
 * command. Every chokepoint that surfaces a `COMMAND_BLOCKED` result
 * (`toolExecution/builtin.ts`, `sandbox/service.ts`) must use this exact
 * string rather than writing its own — a model that sees a bare "this was
 * blocked" has been observed retrying the same command, or a slightly
 * reworded one, believing a different phrasing might get through. The
 * message is deliberately explicit about stopping rather than trusting the
 * model to infer it: it is not a transient failure to work around, it is a
 * standing policy decision that will deny the same command (and any
 * equivalent) again.
 */
export const COMMAND_BLOCKED_MESSAGE =
  'This command was blocked by an administrator-configured command governance rule for this ' +
  'user. This is a policy decision, not a transient error — retrying the same command, a ' +
  'reworded version of it, or an alternative command that achieves the same effect will be ' +
  'blocked again. Do not attempt this action again in any form. Stop this line of action now ' +
  "and tell the user the command was blocked by their administrator's policy.";

/**
 * Governance configuration could not be loaded or evaluated. An enforcement point must
 * not run the command. It is a governance outage, not a policy decision, so callers report it as an
 * error ({@link GOVERNANCE_UNAVAILABLE_MESSAGE}, HTTP 503) and never as a denial by a rule.
 */
export class GovernanceUnavailableError extends Error {
  readonly code = 'GOVERNANCE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Command governance is unavailable', options);
    this.name = 'GovernanceUnavailableError';
  }
}

/**
 * The tool-result message shown to the model when governance could not be evaluated. Unlike
 * {@link COMMAND_BLOCKED_MESSAGE} this is a transient system condition: it must not tell the model
 * the action is forbidden.
 */
export const GOVERNANCE_UNAVAILABLE_MESSAGE =
  'Command governance could not be evaluated right now, so this command was not run. This is a ' +
  'temporary system condition, not a policy decision about the command. You may try again later; ' +
  'if it keeps failing, tell the user that command execution is unavailable.';

/**
 * Master switch: the `command_governance` feature flag, evaluated for the user
 * whose call is governed. Every governance code path (the `builtin.ts`
 * chokepoint AND the `/api/governance/check` + `/api/governance/log` HTTP
 * handlers) must call this FIRST and short-circuit on `false` — the product
 * requirement is that no governance rule, policy or log is touched when the
 * feature is off; the flag lookup itself is cached.
 *
 * Explicitly off is `false`. Flags that cannot be read reject with
 * {@link GovernanceUnavailableError}: enforcement fails closed on an unknown state.
 */
export const isGovernanceEnabled = async (userId: string): Promise<boolean> => {
  try {
    const flags = await getServerFeatureFlagsFromRuntimeConfig(userId);

    const switchValue = FeatureFlagsSchema.shape.command_governance
      .unwrap()
      .parse(flags.command_governance);
    return evaluateFeatureFlag(switchValue, userId) === true;
  } catch (error) {
    // The cause may quote connection details: it is chained, not copied into the message.
    console.error('[governance] feature flag lookup failed, governance state unknown: %O', error);
    throw new GovernanceUnavailableError({ cause: error });
  }
};

const matchesRule = (
  commandText: string,
  pattern: string,
  patternType: CommandGovernancePatternType,
): boolean => {
  switch (patternType) {
    case 'exact': {
      return commandText === pattern;
    }
    case 'prefix': {
      return commandText.startsWith(pattern);
    }
    case 'regex': {
      return new RegExp(pattern).test(commandText);
    }
    default: {
      throw new Error('Unsupported command governance pattern type');
    }
  }
};

/**
 * Evaluate whether `ctx.commandText` is allowed to run.
 *
 * Rejects with {@link GovernanceUnavailableError} when the feature flag cannot be read: the
 * enforcement point must not run a command whose governance state is unknown.
 *
 * Rule lookup and evaluation failures also reject: no enforcement point may execute without
 * successfully evaluating the applicable governance configuration.
 */
export const checkCommand = async (
  ctx: CommandGovernanceContext & { commandText: string },
  db: LobeChatDatabase,
): Promise<CommandGovernanceDecision> => {
  if (!(await isGovernanceEnabled(ctx.userId))) return { allowed: true };

  try {
    const rules = await listEnabledRulesForTarget(db, ctx.userId, ctx.executionTarget);

    for (const rule of rules) {
      if (
        matchesRule(ctx.commandText, rule.pattern, rule.patternType as CommandGovernancePatternType)
      ) {
        log(
          'Denying command for user %s (rule %s, target %s): %s',
          ctx.userId,
          rule.id,
          ctx.executionTarget,
          ctx.commandText,
        );
        return { allowed: false, ruleId: rule.id };
      }
    }

    return { allowed: true };
  } catch (error) {
    console.error('[governance] command evaluation unavailable: %O', error);
    throw new GovernanceUnavailableError({ cause: error });
  }
};
