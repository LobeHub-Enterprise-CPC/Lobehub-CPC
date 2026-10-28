export interface MarketAuthorizationParams {
  authUrl: string;
}

/**
 * Authorization phase for progress tracking
 */
export type AuthorizationPhase =
  | 'browser_opened' // Browser has been opened for authorization
  | 'waiting_for_organization' // Platform flow: waiting for the user to pick an organization in the browser
  | 'waiting_for_auth' // Waiting for user to complete browser login
  | 'verifying' // Received credentials, verifying with server
  | 'awaiting_confirmation' // Tokens verified, waiting for the user to confirm organization and account
  | 'cancelled'; // Authorization was cancelled by user

/**
 * Stable error codes for authorization failures; the renderer maps them to messages.
 */
export type AuthorizationErrorCode =
  | 'AUTHORIZATION_TIMEOUT'
  | 'CONFIRMATION_TIMEOUT'
  | 'ENDPOINT_CHANGED_RESTART_LIMIT'
  | 'ENDPOINT_CHANGED_UPDATE_ADDRESS'
  | 'FLOW_SUPERSEDED'
  | 'HANDOFF_INCONSISTENT'
  | 'IDENTITY_VERIFICATION_FAILED'
  | 'INVALID_ORGANIZATION_ADDRESS'
  | 'INVALID_SERVER_ADDRESS'
  | 'ORGANIZATION_CHANGED_SWITCH_REQUIRED'
  | 'PLATFORM_HANDOFF_REJECTED'
  | 'PLATFORM_MISCONFIGURED'
  | 'PLATFORM_UNAVAILABLE'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'UNKNOWN';

export type AuthorizationStartResult =
  { success: true } | { code?: AuthorizationErrorCode; error: string; success: false };

/** Pending confirmation shown to the user before a verified login becomes active. */
export interface AuthorizationConfirmRequest {
  /** id_token email, then preferred_username, then sub. */
  account: string;
  confirmationId: string;
  /** Normalized entry address; always displayed. */
  entryUrl: string;
  /** Epoch ms after which the confirmation counts as cancelled. */
  expiresAt: number;
  generation: string;
  /** Whether the account belongs to other organizations (id_token claim); absent = unknown. */
  hasOtherOrganizations?: boolean;
  /** Organization name: id_token `tenant_name`, else the platform handoff snapshot; absent when neither exists. */
  name?: string;
  /** Organization slug from the id_token `tenant_slug`; absent = unknown. */
  slug?: string;
}

/** The renderer only ever sends these two fields back. */
export interface AuthorizationConfirmParams {
  confirmationId: string;
  generation: string;
}

export type AuthorizationConfirmResult =
  | { success: true }
  | {
      code: 'COMMIT_FAILED' | 'CONFIRMATION_INVALID' | 'CONFIRMATION_TIMEOUT';
      error: string;
      success: false;
    };

export type AuthorizationConfirmDismissReason =
  'cancelled' | 'confirmed' | 'expired' | 'superseded' | 'switched';

export type TenantEndpointChangedKind = 'relogin_required' | 'update_address_required';

/**
 * Authorization progress info for UI updates
 */
export interface AuthorizationProgress {
  /** Elapsed time in milliseconds since authorization started */
  elapsed: number;
  /** Maximum polling time in milliseconds */
  maxPollTime: number;
  /** Current authorization phase */
  phase: AuthorizationPhase;
}

/**
 * Remote server related events broadcast from main process
 */
export interface RemoteServerBroadcastEvents {
  /** The confirmation card must be closed. */
  authorizationConfirmDismissed: (params: {
    confirmationId: string;
    reason: AuthorizationConfirmDismissReason;
  }) => void;
  /** Tokens verified; ask the user to confirm the organization and account. */
  authorizationConfirmRequired: (params: AuthorizationConfirmRequest) => void;
  authorizationFailed: (params: { code?: AuthorizationErrorCode; error: string }) => void;
  /** Broadcast authorization progress for UI updates */
  authorizationProgress: (params: AuthorizationProgress) => void;
  /**
   * Broadcast when the main process needs the user to re-authenticate.
   * `reason` is a short, log-friendly tag describing why (e.g. `refresh:invalid_grant`,
   * `proxy:status=401`, `startup:non_retryable`). Useful for diagnosing why the
   * Session Expired modal showed up in field reports.
   */
  authorizationRequired: (params: { reason: string }) => void;
  /** An authorization hit 409 TENANT_ENDPOINT_CHANGED and is being restarted automatically. */
  authorizationRestarting: (params: { attempt: number; maxAttempts: number }) => void;
  authorizationSuccessful: (params: void) => void;
  remoteServerConfigUpdated: (params: void) => void;
  /** Logged-in session hit 409 TENANT_ENDPOINT_CHANGED; remote activity is paused. */
  tenantEndpointChanged: (params: { kind: TenantEndpointChangedKind }) => void;
  tokenRefreshed: (params: void) => void;
}
