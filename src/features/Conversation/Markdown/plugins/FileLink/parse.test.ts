import { initializeTenant, setRemoteTenantSlugs } from '@lobechat/business-tenant/client';
import { afterEach, describe, expect, it } from 'vitest';

import { getFileLinkOpenAction, parseFileLinkHref } from './parse';

const ORIGIN = 'https://app.lobehub.com';

afterEach(() => {
  initializeTenant(new URL(ORIGIN));
  setRemoteTenantSlugs(undefined);
});

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
    initializeTenant(new URL(`${ORIGIN}/orgs/acme/agent`));
    expect(parseFileLinkHref(`${ORIGIN}/orgs/beta/f/file_abc123`, ORIGIN)).toBeNull();
    expect(parseFileLinkHref(`${ORIGIN}/orgs/acme/f/file_abc123`, ORIGIN)).toEqual({
      fileId: 'file_abc123',
    });
    expect(parseFileLinkHref('/orgs/acme/f/file_xyz')).toEqual({ fileId: 'file_xyz' });
  });

  it('matches a file proxy link written under a former slug of the current tenant', () => {
    initializeTenant(new URL(`${ORIGIN}/orgs/acme/agent`), {
      basePath: '/orgs/acme',
      formerSlugs: ['acme-old'],
      slug: 'acme',
    });
    expect(parseFileLinkHref(`${ORIGIN}/orgs/acme-old/f/file_abc123`, ORIGIN)).toEqual({
      fileId: 'file_abc123',
    });
    expect(parseFileLinkHref('/t/acme-old/f/file_xyz')).toEqual({ fileId: 'file_xyz' });
    expect(parseFileLinkHref(`${ORIGIN}/orgs/beta/f/file_abc123`, ORIGIN)).toBeNull();
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

  it('does not treat other official subdomains as the app', () => {
    expect(
      parseFileLinkHref('https://staging.app.lobehub.com/f/file_abc123', 'https://lobehub.com'),
    ).toBeNull();
    expect(
      parseFileLinkHref(
        'https://device-gateway.lobehub.com/f/file_abc123',
        'https://app.lobehub.com',
      ),
    ).toBeNull();
  });

  it('does not treat a look-alike host as the official cloud', () => {
    expect(
      parseFileLinkHref('https://lobehub.com.evil.example/f/file_abc123', 'https://lobehub.com'),
    ).toBeNull();
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
    const TENANT = 'https://host/orgs/acme';

    it('matches the tenant-prefixed file proxy link the server renders', () => {
      expect(parseFileLinkHref('https://host/orgs/acme/f/file_1', TENANT)).toEqual({
        fileId: 'file_1',
      });
      expect(parseFileLinkHref('https://host/orgs/acme/f/file_1', `${TENANT}/`)).toEqual({
        fileId: 'file_1',
      });
    });

    it('matches a root-relative link, with or without the tenant prefix', () => {
      expect(parseFileLinkHref('/f/file_1', TENANT)).toEqual({ fileId: 'file_1' });
      expect(parseFileLinkHref('/orgs/acme/f/file_1', TENANT)).toEqual({ fileId: 'file_1' });
    });

    it('rejects another tenant and a sibling slug on the same host', () => {
      expect(parseFileLinkHref('https://host/orgs/other/f/file_1', TENANT)).toBeNull();
      expect(parseFileLinkHref('https://host/orgs/acme-x/f/file_1', TENANT)).toBeNull();
      expect(parseFileLinkHref('/orgs/other/f/file_1', TENANT)).toBeNull();
    });

    it('rejects a link on the same host that carries no tenant prefix', () => {
      expect(parseFileLinkHref('https://host/f/file_1', TENANT)).toBeNull();
    });

    it('rejects a link to another origin', () => {
      expect(parseFileLinkHref('https://evil.example/orgs/acme/f/file_1', TENANT)).toBeNull();
    });

    // A desktop keeps the address it signed in with after a rename; links carry the new slug.
    it('matches the other slugs of the remote tenant', () => {
      setRemoteTenantSlugs(['acme-new', 'acme']);
      expect(parseFileLinkHref('https://host/orgs/acme-new/f/file_1', TENANT)).toEqual({
        fileId: 'file_1',
      });
      expect(parseFileLinkHref('/orgs/acme-new/f/file_1', TENANT)).toEqual({ fileId: 'file_1' });
      expect(parseFileLinkHref('https://host/orgs/other/f/file_1', TENANT)).toBeNull();
      expect(parseFileLinkHref('https://evil.example/orgs/acme-new/f/file_1', TENANT)).toBeNull();
    });

    it('matches the root address of a custom domain', () => {
      expect(parseFileLinkHref('https://custom.host/f/file_1', 'https://custom.host')).toEqual({
        fileId: 'file_1',
      });
    });
  });
});

describe('getFileLinkOpenAction', () => {
  const link = { fileId: 'file_1', label: 'report.md', linkHref: `${ORIGIN}/f/file_1` };

  it('opens the owner-scoped preview by id for the file owner', () => {
    expect(getFileLinkOpenAction({ ...link, isAgentShareVisitor: false })).toEqual({
      kind: 'preview',
      params: { fileId: 'file_1' },
    });
  });

  // Regression: the visitor does not own the creator's file, so the
  // id-only preview fetched nothing and showed "file unavailable".
  it('previews from the public /f/:id link on the agent-share visitor page', () => {
    expect(getFileLinkOpenAction({ ...link, isAgentShareVisitor: true })).toEqual({
      kind: 'preview',
      params: { fileId: 'file_1', source: { name: 'report.md', url: `${ORIGIN}/f/file_1` } },
    });
  });

  it('opens the public link in a new tab when the visitor label names no file type', () => {
    expect(
      getFileLinkOpenAction({ ...link, isAgentShareVisitor: true, label: 'Download the deck' }),
    ).toEqual({ kind: 'newTab', url: `${ORIGIN}/f/file_1` });
  });
});
