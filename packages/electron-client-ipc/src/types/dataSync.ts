export type StorageMode = 'cloud' | 'selfHost';
export enum StorageModeEnum {
  Cloud = 'cloud',
  SelfHost = 'selfHost',
}

/**
 * Verified identity of the account that was confirmed for a tenant entry.
 * Comes from signature-verified OIDC tokens, never from renderer input.
 */
export interface CloudTenantIdentity {
  issuer: string;
  subject: string;
  tenantId: string;
}

/** Display-only data; never used for any trust decision. */
export interface CloudTenantDisplay {
  account: string;
  /**
   * Whether the account belongs to other organizations too (id_token `has_other_organizations`).
   * Absent = unknown. Only decides whether "switch organization" is offered.
   */
  hasOtherOrganizations?: boolean;
  /** From the id_token `tenant_name`, else the platform handoff snapshot, else kept from a same-identity re-login. */
  organizationName?: string;
  /** Organization slug from the id_token `tenant_slug`; absent = unknown. */
  organizationSlug?: string;
}

/**
 * The tenant entry (and the account) the user confirmed. Persisted as one object so a
 * single store write commits it atomically; the stored tokens carry the same `generation`.
 * Only the main process writes it.
 */
export interface CloudTenant {
  display: CloudTenantDisplay;
  entryUrl: string;
  /** Random UUID of the authorization that committed this record. */
  generation: string;
  identity: CloudTenantIdentity;
}

/**
 * Remote server configuration related events
 */
export interface DataSyncConfig {
  active?: boolean;
  cloudTenant?: CloudTenant;
  remoteServerUrl?: string;
  storageMode: StorageMode;
}
