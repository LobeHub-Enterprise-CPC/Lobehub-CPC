/** Shared public database values. Ciphertext is stored separately as nullable text. */
export interface OAuth2ProfileMapping {
  email: string;
  emailVerified: string;
  id: string;
  image: string;
  name: string;
}
/**
 * Generic OAuth 2.0 only. `preset` stays in the stored JSON (always `custom`);
 * rows an older build wrote for a named vendor are skipped at load time.
 */
export interface SsoOAuth2Config {
  authorizationEndpoint: string;
  clientId: string;
  mapping: OAuth2ProfileMapping;
  pkce: boolean;
  preset: 'custom';
  scopes: string[];
  tokenEndpoint: string;
  tokenEndpointAuthentication: 'client_secret_basic' | 'client_secret_post';
  userInfoEndpoint: string;
}
export interface SsoOidcConfig {
  authorizationEndpoint?: string;
  clientId: string;
  discoveryEndpoint?: string;
  /** Old writers included these two redundant keys. Preserve historical JSON on conversion. */
  issuer?: string;
  jwksEndpoint?: string;
  pkce: boolean;
  protocol?: 'oidc';
  scopes: string[];
  tokenEndpoint?: string;
  tokenEndpointAuthentication?: 'client_secret_basic' | 'client_secret_post';
  userInfoEndpoint?: string;
}
