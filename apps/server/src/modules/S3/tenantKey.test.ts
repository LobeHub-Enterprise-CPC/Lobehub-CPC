// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it } from 'vitest';

import { logicalObjectKey, tenantObjectKey } from './tenantKey';

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: 'acme', tenantId } as unknown as TenantScope, fn);

describe('tenant object keys', () => {
  it('stores every object under the current tenant root', () => {
    expect(inTenant('tenant-1', () => tenantObjectKey('files/2026/a.png'))).toBe(
      't/tenant-1/files/2026/a.png',
    );
    expect(inTenant('tenant-1', () => tenantObjectKey('/files/a.png'))).toBe(
      't/tenant-1/files/a.png',
    );
  });

  it('never lets a key address another tenant', () => {
    expect(inTenant('tenant-1', () => tenantObjectKey('t/tenant-2/files/a.png'))).toBe(
      't/tenant-1/t/tenant-2/files/a.png',
    );
  });

  it('refuses storage access outside a tenant', () => {
    expect(() => tenantObjectKey('files/a.png')).toThrow(/TENANT_REQUIRED/);
  });

  it('reads back only keys of the current tenant', () => {
    expect(inTenant('tenant-1', () => logicalObjectKey('t/tenant-1/files/a.png'))).toBe(
      'files/a.png',
    );
    expect(inTenant('tenant-1', () => logicalObjectKey('t/tenant-2/files/a.png'))).toBeNull();
    expect(inTenant('tenant-1', () => logicalObjectKey('files/a.png'))).toBeNull();
  });

  it.each([
    ['dot segment', 'files/./a.png'],
    ['dot-dot segment', 'files/../t/tenant-2/a.png'],
    ['leading dot-dot', '../a.png'],
    ['trailing dot-dot', 'files/..'],
    ['backslash', 'files\\..\\a.png'],
    ['empty segment', 'files//a.png'],
    ['trailing slash', 'files/a/'],
    ['NUL', 'files/a\u0000.png'],
    ['newline', 'files/a\n.png'],
    ['DEL', 'files/a\u007F.png'],
    ['only slashes', '///'],
  ])('rejects a logical key with %s', (_name, key) => {
    expect(() => inTenant('tenant-1', () => tenantObjectKey(key))).toThrow(
      'TENANT_OBJECT_KEY_INVALID',
    );
    expect(() => inTenant('tenant-1', () => logicalObjectKey(`t/tenant-1/${key}`))).toThrow(
      'TENANT_OBJECT_KEY_INVALID',
    );
  });

  it.each([
    'files/user_1/abc123/report v2 (final).pdf',
    'files/user_1/abc123/中文 文件.png',
    'files/2026/05/a..b.png',
    'files/.hidden/.env',
    'avatars/user_1/12345.webp',
    'skills/source_files/0a1b2c/refs/guide.md',
    'tracing/agent_1/topic_1/op_1.json.zst',
    'generations/images/uuid_1024x1024_20260101_raw.png',
  ])('keeps legitimate key shape %s', (key) => {
    expect(inTenant('tenant-1', () => tenantObjectKey(key))).toBe(`t/tenant-1/${key}`);
    expect(inTenant('tenant-1', () => logicalObjectKey(`t/tenant-1/${key}`))).toBe(key);
  });
});
