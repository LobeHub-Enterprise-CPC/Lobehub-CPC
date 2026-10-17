import { initializeTenant } from '@lobechat/business-tenant/client';
import { describe, expect, it } from 'vitest';

import { parseFileLinkHref } from './parse';

const ORIGIN = 'https://app.lobehub.com';

describe('parseFileLinkHref', () => {
  it('matches a same-origin absolute file proxy link', () => {
    expect(parseFileLinkHref(`${ORIGIN}/f/file_abc123`, ORIGIN)).toEqual({
      fileId: 'file_abc123',
    });
  });

  it('matches a root-relative file proxy link regardless of currentOrigin', () => {
    expect(parseFileLinkHref('/f/file_xyz')).toEqual({ fileId: 'file_xyz' });
    expect(parseFileLinkHref('/f/file_xyz', ORIGIN)).toEqual({ fileId: 'file_xyz' });
  });

  it('matches a file proxy link of the current tenant only', () => {
    initializeTenant(new URL(`${ORIGIN}/t/acme/agent`));
    expect(parseFileLinkHref(`${ORIGIN}/t/beta/f/file_abc123`, ORIGIN)).toBeNull();
    expect(parseFileLinkHref(`${ORIGIN}/t/acme/f/file_abc123`, ORIGIN)).toEqual({
      fileId: 'file_abc123',
    });
    expect(parseFileLinkHref('/t/acme/f/file_xyz')).toEqual({ fileId: 'file_xyz' });
    initializeTenant(new URL(ORIGIN));
  });

  it('decodes an encoded file id', () => {
    expect(parseFileLinkHref('/f/file%20with%20space', ORIGIN)).toEqual({
      fileId: 'file with space',
    });
  });

  it('returns null instead of throwing on a malformed percent-encoded file id', () => {
    expect(parseFileLinkHref('/f/%', ORIGIN)).toBeNull();
  });

  it('does not match a cross-origin link sharing the same path shape', () => {
    expect(parseFileLinkHref('https://example.com/f/not-ours', ORIGIN)).toBeNull();
  });

  it('does not match an absolute link when no currentOrigin is known', () => {
    expect(parseFileLinkHref(`${ORIGIN}/f/file_abc123`)).toBeNull();
  });

  it('does not match a normal external link', () => {
    expect(parseFileLinkHref('https://example.com/docs', ORIGIN)).toBeNull();
  });

  it('does not match other app routes', () => {
    expect(parseFileLinkHref('/api/agent/stream', ORIGIN)).toBeNull();
    expect(parseFileLinkHref('/features/foo', ORIGIN)).toBeNull();
  });

  it('returns null for an empty href', () => {
    expect(parseFileLinkHref(undefined, ORIGIN)).toBeNull();
    expect(parseFileLinkHref('', ORIGIN)).toBeNull();
  });

  // The desktop renderer is not a tenant document, so the tenant comes from the
  // address of the remote server it is connected to.
  describe('against a desktop tenant address', () => {
    const TENANT = 'https://host/t/acme';

    it('matches the tenant-prefixed file proxy link the server renders', () => {
      expect(parseFileLinkHref('https://host/t/acme/f/file_1', TENANT)).toEqual({
        fileId: 'file_1',
      });
      expect(parseFileLinkHref('https://host/t/acme/f/file_1', `${TENANT}/`)).toEqual({
        fileId: 'file_1',
      });
    });

    it('matches a root-relative link, with or without the tenant prefix', () => {
      expect(parseFileLinkHref('/f/file_1', TENANT)).toEqual({ fileId: 'file_1' });
      expect(parseFileLinkHref('/t/acme/f/file_1', TENANT)).toEqual({ fileId: 'file_1' });
    });

    it('rejects another tenant and a sibling slug on the same host', () => {
      expect(parseFileLinkHref('https://host/t/other/f/file_1', TENANT)).toBeNull();
      expect(parseFileLinkHref('https://host/t/acme-x/f/file_1', TENANT)).toBeNull();
      expect(parseFileLinkHref('/t/other/f/file_1', TENANT)).toBeNull();
    });

    it('rejects a link on the same host that carries no tenant prefix', () => {
      expect(parseFileLinkHref('https://host/f/file_1', TENANT)).toBeNull();
    });

    it('rejects a link to another origin', () => {
      expect(parseFileLinkHref('https://evil.example/t/acme/f/file_1', TENANT)).toBeNull();
    });

    it('matches the root address of a custom domain', () => {
      expect(parseFileLinkHref('https://custom.host/f/file_1', 'https://custom.host')).toEqual({
        fileId: 'file_1',
      });
    });
  });
});
