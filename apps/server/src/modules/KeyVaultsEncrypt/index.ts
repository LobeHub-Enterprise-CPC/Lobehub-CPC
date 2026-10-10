import { requireTenantScope } from '@lobechat/database/tenant';

import {
  deriveTenantDataKey,
  MasterKeyError,
  openWithKey,
  sealWithKey,
} from '@/server/crypto/tenantKeys';
import { type UserKeyVaults } from '@/types/user/settings';

interface DecryptionResult {
  plaintext: string;
  wasAuthentic: boolean;
}

/**
 * Encrypts secrets stored in the tenant schema (user key vaults, provider
 * keys, connector and bot credentials, …) with the tenant data key derived
 * from `KEY_VAULTS_SECRET` (spec A18). Ciphertexts are the shared
 * `v1.<iv>.<ciphertext>.<tag>` envelope; one tenant's key cannot open another
 * tenant's data.
 */
const tenantKey = (tenantId: string) => {
  try {
    return deriveTenantDataKey(tenantId);
  } catch (error) {
    if (error instanceof MasterKeyError)
      throw new Error(
        ` \`KEY_VAULTS_SECRET\` is not set, please set it in your environment variables.

If you don't have it, please run \`openssl rand -base64 32\` to create one.
`,
        { cause: error },
      );
    throw error;
  }
};

export class KeyVaultsGateKeeper {
  constructor(private readonly resolveKey: () => Buffer) {}

  /**
   * The gatekeeper of the current tenant. Outside a tenant scope this fails
   * with `TENANT_REQUIRED`: there is no process-wide data key.
   *
   * The key is resolved from the tenant scope on every call, so a gatekeeper
   * cached in a long-lived object can never encrypt one tenant's data with
   * another tenant's key.
   */
  static initWithEnvKey = async (): Promise<KeyVaultsGateKeeper> => {
    tenantKey(requireTenantScope().tenantId);
    return new KeyVaultsGateKeeper(() => tenantKey(requireTenantScope().tenantId));
  };

  /** A gatekeeper pinned to one tenant, for work that runs outside its request scope. */
  static forTenant = (tenantId: string): KeyVaultsGateKeeper => {
    const key = tenantKey(tenantId);
    return new KeyVaultsGateKeeper(() => key);
  };

  /** Encrypts user private data. */
  encrypt = async (keyVault: string): Promise<string> => sealWithKey(this.resolveKey(), keyVault);

  decrypt = async (encryptedData: string): Promise<DecryptionResult> => {
    if (!encryptedData.startsWith('v1.') || encryptedData.split('.').length !== 4)
      throw new Error('Invalid encrypted data format');
    try {
      return { plaintext: openWithKey(this.resolveKey(), encryptedData), wasAuthentic: true };
    } catch {
      return { plaintext: '', wasAuthentic: false };
    }
  };

  static getUserKeyVaults = async (
    encryptedKeyVaults: string | null,
    userId?: string,
  ): Promise<UserKeyVaults> => {
    if (!encryptedKeyVaults) return {};
    let decryptKeyVaults = {};

    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    const { wasAuthentic, plaintext } = await gateKeeper.decrypt(encryptedKeyVaults);

    if (wasAuthentic) {
      try {
        if (!!plaintext) decryptKeyVaults = JSON.parse(plaintext);
      } catch (e) {
        console.error(`Failed to parse keyVaults, userId: ${userId}. Error:`, e);
      }
    }

    return decryptKeyVaults as UserKeyVaults;
  };
}
