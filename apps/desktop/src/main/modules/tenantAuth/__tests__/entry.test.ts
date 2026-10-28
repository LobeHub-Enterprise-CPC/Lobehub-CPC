import { describe, expect, it } from 'vitest';

import { classifyEntry, normalizeEntryUrl } from '../entry';

const PLATFORM = 'https://platform.example';

describe('normalizeEntryUrl', () => {
  it('canonicalizes https addresses and drops query, hash and trailing slashes', () => {
    expect(normalizeEntryUrl(' HTTPS://Platform.Example/orgs/acme/?x=1#y ')).toBe(
      'https://platform.example/orgs/acme',
    );
  });

  it('rejects plain http, credentials and non-http schemes', () => {
    expect(normalizeEntryUrl('http://platform.example/orgs/acme')).toBeNull();
    expect(normalizeEntryUrl('https://user:pw@platform.example')).toBeNull();
    expect(normalizeEntryUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeEntryUrl('not a url')).toBeNull();
  });

  it('respells a legacy /t entry so a login stored under it is made again', () => {
    expect(normalizeEntryUrl('https://platform.example/orgs/acme/')).toBe(
      'https://platform.example/orgs/acme',
    );
    expect(normalizeEntryUrl('https://platform.example/orgs/acme')).toBe(
      'https://platform.example/orgs/acme',
    );
  });

  it('allows http only for loopback hosts and only when development asks for it', () => {
    expect(normalizeEntryUrl('http://localhost:3010/orgs/acme')).toBeNull();
    expect(normalizeEntryUrl('http://localhost:3010/orgs/acme', true)).toBe(
      'http://localhost:3010/orgs/acme',
    );
    expect(normalizeEntryUrl('http://127.0.0.1:3010', true)).toBe('http://127.0.0.1:3010');
    expect(normalizeEntryUrl('http://192.168.1.2:3010', true)).toBeNull();
  });
});

describe('classifyEntry', () => {
  it.each([
    [PLATFORM, 'platform'],
    [`${PLATFORM}/orgs/acme`, 'tenant'],
    [`${PLATFORM}/orgs/acme/extra`, 'invalid'],
    [`${PLATFORM}/orgs/A`, 'invalid'],
    [`${PLATFORM}/agent`, 'invalid'],
    ['https://chat.customer.example', 'tenant'],
    ['https://self-host.example/sub', 'tenant'],
  ])('%s is %s', (url, kind) => {
    expect(classifyEntry(url, PLATFORM).kind).toBe(kind);
  });

  it('reports the slug of a /orgs/{slug} entry', () => {
    expect(classifyEntry(`${PLATFORM}/orgs/acme-co`, PLATFORM)).toEqual({
      kind: 'tenant',
      slug: 'acme-co',
    });
  });
});
