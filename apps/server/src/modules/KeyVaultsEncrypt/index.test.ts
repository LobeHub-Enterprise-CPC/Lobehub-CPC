// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyVaultsGateKeeper } from './index';

const scope = (tenantId: string) =>
  ({ session: {}, slug: 'acme', tenantId }) as unknown as TenantScope;
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  runWithTenantScope(scope(tenantId), fn);

describe('KeyVaultsGateKeeper', () => {
  let gateKeeper: KeyVaultsGateKeeper;
  let originalSecret: string | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalSecret = process.env.KEY_VAULTS_SECRET;
    process.env.KEY_VAULTS_SECRET = 'Q10pwdq00KXUu9R+c8A8p4PSlIRWi7KwgUophBtkHVk=';
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gateKeeper = KeyVaultsGateKeeper.forTenant('tenant-a');
  });

  afterEach(() => {
    process.env.KEY_VAULTS_SECRET = originalSecret;
    consoleErrorSpy.mockRestore();
  });

  it('encrypts into the v1 envelope and decrypts back', async () => {
    const encryptedData = await gateKeeper.encrypt('sensitive user data');
    expect(encryptedData.startsWith('v1.')).toBe(true);
    const decryptionResult = await gateKeeper.decrypt(encryptedData);

    expect(decryptionResult.plaintext).toBe('sensitive user data');
    expect(decryptionResult.wasAuthentic).toBe(true);
  });

  it('refuses to build a gatekeeper outside a tenant scope', async () => {
    await expect(KeyVaultsGateKeeper.initWithEnvKey()).rejects.toThrow('TENANT_REQUIRED');
  });

  it("cannot open another tenant's data", async () => {
    const encrypted = await gateKeeper.encrypt('secret');
    const other = KeyVaultsGateKeeper.forTenant('tenant-b');
    await expect(other.decrypt(encrypted)).resolves.toEqual({ plaintext: '', wasAuthentic: false });
  });

  it('a cached scope gatekeeper follows the tenant it is used in', async () => {
    const cached = await inTenant('tenant-a', () => KeyVaultsGateKeeper.initWithEnvKey());
    const sealedInB = await inTenant('tenant-b', () => cached.encrypt('b-secret'));
    await expect(KeyVaultsGateKeeper.forTenant('tenant-b').decrypt(sealedInB)).resolves.toEqual({
      plaintext: 'b-secret',
      wasAuthentic: true,
    });
    await expect(cached.encrypt('outside')).rejects.toThrow('TENANT_REQUIRED');
  });

  it('should throw an error if KEY_VAULTS_SECRET is not set', async () => {
    process.env.KEY_VAULTS_SECRET = '';

    await expect(inTenant('tenant-a', () => KeyVaultsGateKeeper.initWithEnvKey())).rejects.toThrow(
      '`KEY_VAULTS_SECRET` is not set',
    );
  });

  it('rejects the legacy `iv:tag:ciphertext` format instead of reading it', async () => {
    await expect(gateKeeper.decrypt('aabb:ccdd:eeff')).rejects.toThrow(
      'Invalid encrypted data format',
    );
    await expect(gateKeeper.decrypt('invalid-format')).rejects.toThrow(
      'Invalid encrypted data format',
    );
  });

  it('should return empty plaintext and false authenticity for a tampered envelope', async () => {
    const [v, iv, , tag] = (await gateKeeper.encrypt('x')).split('.');
    const decryptionResult = await gateKeeper.decrypt([v, iv, 'AAAA', tag].join('.'));

    expect(decryptionResult.plaintext).toBe('');
    expect(decryptionResult.wasAuthentic).toBe(false);
  });

  describe('getUserKeyVaults', () => {
    it('should return an empty object when encrypted key vaults are missing', async () => {
      await expect(KeyVaultsGateKeeper.getUserKeyVaults(null)).resolves.toEqual({});
    });

    it('should decrypt and parse valid key vaults json', async () => {
      const encrypted = await gateKeeper.encrypt(JSON.stringify({ openai: 'sk-test' }));

      await expect(
        inTenant('tenant-a', () => KeyVaultsGateKeeper.getUserKeyVaults(encrypted)),
      ).resolves.toEqual({ openai: 'sk-test' });
    });

    it('should return an empty object when ciphertext is not authentic', async () => {
      const encrypted = await gateKeeper.encrypt(JSON.stringify({ openai: 'sk-test' }));
      process.env.KEY_VAULTS_SECRET = 'another-master-secret';

      await expect(
        inTenant('tenant-a', () => KeyVaultsGateKeeper.getUserKeyVaults(encrypted)),
      ).resolves.toEqual({});
    });

    it('should log parse errors and return an empty object for non-json plaintext', async () => {
      const encrypted = await gateKeeper.encrypt('not-json');

      await expect(
        inTenant('tenant-a', () => KeyVaultsGateKeeper.getUserKeyVaults(encrypted, 'user-1')),
      ).resolves.toEqual({});

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to parse keyVaults, userId: user-1. Error:',
        expect.any(SyntaxError),
      );
    });
  });
});
