/** Shared public database values. Ciphertext is stored separately as nullable text. */
export interface OAuth2ProfileMapping {
  email: string;
  emailVerified: string;
  id: string;
  image: string;
  name: string;
}
export type SsoOAuth2Config = { clientId: string } & (
  | { preset: 'dingtalk' | 'discord' | 'feishu' | 'github' }
  | { agentId: string; preset: 'wecom' }
  | {
      authorizationEndpoint: string;
      mapping: OAuth2ProfileMapping;
      pkce: boolean;
      preset: 'custom';
      scopes: string[];
      tokenEndpoint: string;
      tokenEndpointAuthentication: 'client_secret_basic' | 'client_secret_post';
      userInfoEndpoint: string;
    }
);
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
export interface SsoSamlConfig {
  /** Admin-local callback. Absent from the CPC mirror, which derives its own URL. */
  callbackUrl?: string;
  cert: string;
  entryPoint: string;
  idpMetadata: { metadata: string };
  mapping: { emailVerified: string };
  /** Admin-local SP identity. Absent from the CPC mirror. Never contains a private key. */
  spMetadata?: { entityID: string };
}
