import { type AuthorizationPhase } from '@lobechat/electron-client-ipc';

import { type AuthorizationUiErrorCode } from '@/store/electron/initialState';
import { type DefaultResources } from '@/types/locale';

export type DesktopOnboardingI18nKey = keyof DefaultResources['desktop-onboarding'];

/**
 * Every code the main process can report, mapped to desktop-onboarding copy. `null` means the
 * event is bookkeeping (a superseded flow) and must not be shown. The `Record` makes adding a
 * code in the IPC contract a type error until it gets copy here.
 */
export const authorizationErrorI18nKeyMap: Record<
  AuthorizationUiErrorCode,
  DesktopOnboardingI18nKey | null
> = {
  AUTHORIZATION_TIMEOUT: 'screen5.errors.timedOut',
  COMMIT_FAILED: 'screen5.errors.commitFailed',
  CONFIRMATION_INVALID: 'screen5.errors.confirmationInvalid',
  CONFIRMATION_TIMEOUT: 'screen5.errors.confirmationTimeout',
  ENDPOINT_CHANGED_RESTART_LIMIT: 'screen5.errors.endpointChangedRestartLimit',
  ENDPOINT_CHANGED_UPDATE_ADDRESS: 'screen5.errors.endpointChangedUpdateAddress',
  FLOW_SUPERSEDED: null,
  HANDOFF_INCONSISTENT: 'screen5.errors.generic',
  IDENTITY_VERIFICATION_FAILED: 'screen5.errors.identityVerificationFailed',
  INVALID_ORGANIZATION_ADDRESS: 'screen5.errors.invalidOrganizationAddress',
  INVALID_SERVER_ADDRESS: 'screen5.errors.invalidServerAddress',
  ORGANIZATION_CHANGED_SWITCH_REQUIRED: 'screen5.errors.organizationChangedSwitchRequired',
  PLATFORM_HANDOFF_REJECTED: 'screen5.errors.platformHandoffRejected',
  PLATFORM_MISCONFIGURED: 'screen5.errors.platformMisconfigured',
  PLATFORM_UNAVAILABLE: 'screen5.errors.platformUnavailable',
  TOKEN_EXCHANGE_FAILED: 'screen5.errors.generic',
  UNKNOWN: 'screen5.errors.generic',
};

/** Copy key for a code, or undefined when the code is unknown to this build or is not user-facing. */
export const getAuthorizationErrorI18nKey = (
  code?: AuthorizationUiErrorCode,
): DesktopOnboardingI18nKey | undefined =>
  (code && authorizationErrorI18nKeyMap[code]) || undefined;

/** The typed address is not an organization: offer the organization-email lookup instead. */
export const canFindByOrganizationEmail = (code?: AuthorizationUiErrorCode) =>
  code === 'INVALID_ORGANIZATION_ADDRESS';

/** Auto-recovery found a different organization: only an explicit switch may continue. */
export const requiresExplicitSwitch = (code?: AuthorizationUiErrorCode) =>
  code === 'ORGANIZATION_CHANGED_SWITCH_REQUIRED';

/** A superseded flow is replaced by a newer one; its failure is not something to report. */
export const isSupersededAuthorization = (code?: AuthorizationUiErrorCode) =>
  code === 'FLOW_SUPERSEDED';

/** Progress phase to the line shown while a sign-in is waiting on the browser or on main. */
export const authorizationPhaseI18nKeyMap: Record<AuthorizationPhase, DesktopOnboardingI18nKey> = {
  awaiting_confirmation: 'screen5.auth.phase.awaitingConfirmation',
  browser_opened: 'screen5.auth.phase.browserOpened',
  cancelled: 'screen5.actions.cancel',
  verifying: 'screen5.auth.phase.verifying',
  waiting_for_auth: 'screen5.auth.phase.waitingForAuth',
  waiting_for_organization: 'screen5.auth.phase.waitingForOrganization',
};
