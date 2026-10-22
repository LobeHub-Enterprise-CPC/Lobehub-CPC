export interface OidcClientMetadata {
  clientName?: string;
  developerName?: string;
  isFirstParty: boolean;
  logo?: string;
  policyUri?: string;
}

export interface OidcInteractionDetailsResponse {
  acceptanceReview?: { allowed: boolean; title?: string };
  /** The signed-in account the consent is for; absent unless it matches this browser's session. */
  account?: { avatar?: string; email?: string; name?: string };
  clientId: string;
  clientMetadata: OidcClientMetadata;
  prompt: 'consent' | 'login';
  redirectUri?: string;
  scopes: string[];
  uid: string;
}

export interface OidcInteractionErrorResponse {
  error: 'server_error' | 'session_invalid' | 'unsupported_interaction';
  promptName?: string;
}
