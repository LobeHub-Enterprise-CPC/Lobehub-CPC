import { describe, expect, it } from 'vitest';

import { artifactSharePath, artifactShareUrl } from './artifactShare';

describe('artifactShareUrl', () => {
  it.each([
    ['https://host/orgs/acme', 'https://host/orgs/acme/share/artifact/dep_1'],
    ['https://host/orgs/acme/', 'https://host/orgs/acme/share/artifact/dep_1'],
    ['https://custom.host', 'https://custom.host/share/artifact/dep_1'],
    ['https://custom.host/', 'https://custom.host/share/artifact/dep_1'],
  ])('mounts the share path under the server address %s', (serverUrl, expected) => {
    expect(artifactShareUrl(serverUrl, 'dep_1')).toBe(expected);
    expect(artifactSharePath('dep_1')).toBe('/share/artifact/dep_1');
  });
});
