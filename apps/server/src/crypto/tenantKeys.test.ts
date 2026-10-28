// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  deriveDirectoryKey,
  deriveTenantDataKey,
  MasterKeyError,
  openTenantData,
  openWithKey,
  sealTenantData,
  sealWithKey,
} from './tenantKeys';

const env = { KEY_VAULTS_SECRET: 'test-master-secret' };

describe('tenant keys', () => {
  it('reproduces the shared test vector (must match Admin byte for byte)', () => {
    expect(deriveTenantDataKey('tenant-0001', env).toString('hex')).toBe(
      'd4b9d42be905b94094c731cc145fbe6cfa31017d5f1bae1e5d5462f35d18e6f2',
    );
  });

  it('derives different keys per tenant and a separate directory key', () => {
    const a = deriveTenantDataKey('tenant-a', env);
    const b = deriveTenantDataKey('tenant-b', env);
    const directory = deriveDirectoryKey(env);
    expect(a.equals(b)).toBe(false);
    expect(directory.equals(a)).toBe(false);
    expect(directory).toHaveLength(32);
  });

  it('refuses to derive without a master secret or tenant id', () => {
    expect(() => deriveTenantDataKey('tenant-a', {})).toThrow(MasterKeyError);
    expect(() => deriveTenantDataKey('', env)).toThrow(MasterKeyError);
    expect(() => deriveDirectoryKey({})).toThrow(MasterKeyError);
  });

  it('seals into a v1 envelope and opens it back', () => {
    const key = deriveTenantDataKey('tenant-a', env);
    const envelope = sealWithKey(key, 'secret', 'aad');
    const parts = envelope.split('.');
    expect(parts[0]).toBe('v1');
    expect(parts).toHaveLength(4);
    expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3], 'base64url')).toHaveLength(16);
    expect(openWithKey(key, envelope, 'aad')).toBe('secret');
  });

  it('fails closed on another tenant, another AAD, a tampered body or a foreign format', () => {
    const key = deriveTenantDataKey('tenant-a', env);
    const envelope = sealWithKey(key, 'secret', 'aad');
    expect(() => openWithKey(deriveTenantDataKey('tenant-b', env), envelope, 'aad')).toThrow(
      'ENCRYPTED_PAYLOAD_INVALID',
    );
    expect(() => openWithKey(key, envelope, 'other')).toThrow('ENCRYPTED_PAYLOAD_INVALID');
    const [v, iv, , tag] = envelope.split('.');
    expect(() => openWithKey(key, [v, iv, 'AAAA', tag].join('.'), 'aad')).toThrow(
      'ENCRYPTED_PAYLOAD_INVALID',
    );
    expect(() => openWithKey(key, 'aabb:ccdd:eeff', 'aad')).toThrow('ENCRYPTED_PAYLOAD_INVALID');
  });

  it('round-trips tenant data through the process master secret', () => {
    const previous = process.env.KEY_VAULTS_SECRET;
    process.env.KEY_VAULTS_SECRET = 'test-master-secret';
    try {
      const envelope = sealTenantData('tenant-0001', '{"k":1}', 'tenant-0001|p|1');
      expect(openTenantData('tenant-0001', envelope, 'tenant-0001|p|1')).toBe('{"k":1}');
    } finally {
      process.env.KEY_VAULTS_SECRET = previous;
    }
  });
});
