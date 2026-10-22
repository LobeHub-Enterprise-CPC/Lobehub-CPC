// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { userRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('userRouter procedures', () => {
  const procedures = (userRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<
  [name: string, type: 'mutation' | 'query' | 'subscription', middlewares: number]
> {
  return [
    ['confirmOnboardingUnderstanding', 'mutation', 15],
    ['createOnboardingTasks', 'mutation', 14],
    ['finishOnboarding', 'mutation', 12],
    ['getOnboardingAgentContext', 'query', 11],
    ['getOnboardingBootstrapState', 'query', 11],
    ['getOnboardingTaskRecommendations', 'query', 14],
    ['getOnboardingUnderstanding', 'query', 15],
    ['getOrCreateOnboardingState', 'query', 11],
    ['getSupportedUnderstandingProviders', 'query', 14],
    ['getUserActivitySummary', 'query', 11],
    ['getUserRegistrationDuration', 'query', 11],
    ['getUserSSOProviders', 'query', 11],
    ['getUserState', 'query', 11],
    ['makeUserOnboarded', 'mutation', 11],
    ['patchOnboardingDocument', 'mutation', 12],
    ['readOnboardingDocument', 'query', 12],
    ['resetAgentOnboarding', 'mutation', 11],
    ['resetSettings', 'mutation', 11],
    ['retryOnboardingUnderstandingSource', 'mutation', 15],
    ['reviseOnboardingUnderstanding', 'mutation', 15],
    ['saveUserQuestion', 'mutation', 12],
    ['sendOnboardingFirstMessage', 'mutation', 12],
    ['startOnboardingUnderstanding', 'mutation', 15],
    ['updateAgentOnboarding', 'mutation', 12],
    ['updateAvatar', 'mutation', 12],
    ['updateFullName', 'mutation', 12],
    ['updateGuide', 'mutation', 12],
    ['updateInterests', 'mutation', 12],
    ['updateOnboarding', 'mutation', 12],
    ['updateOnboardingDocument', 'mutation', 12],
    ['updatePersonalSystemAgent', 'mutation', 12],
    ['updatePreference', 'mutation', 12],
    ['updateSettings', 'mutation', 12],
    ['updateToolChannels', 'mutation', 12],
    ['updateToolIntervention', 'mutation', 12],
    ['updateUninstalledBuiltinTools', 'mutation', 12],
    ['updateUsername', 'mutation', 12],
    ['watchOnboardingGenerationProgress', 'subscription', 14],
  ];
}
