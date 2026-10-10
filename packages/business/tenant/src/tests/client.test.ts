import { afterEach, describe, expect, it } from 'vitest';

import { getTenant, initializeTenant } from '../client';
import { resolveTenant } from '../resolve';

afterEach(() => initializeTenant(new URL('https://app.test/')));

describe('document tenant context', () => {
  it('keeps the entry tenant until a new document is initialized', () => {
    const address = new URL('https://app.test/t/acme/signin');
    initializeTenant(address);
    address.pathname = '/t/other/signin';

    expect(getTenant()).toEqual({ basePath: '/t/acme', slug: 'acme' });
    initializeTenant(address);
    expect(getTenant()).toEqual({ basePath: '/t/other', slug: 'other' });
  });

  it('clears the previous tenant on an unscoped document', () => {
    initializeTenant(new URL('https://app.test/t/acme/agent'));
    initializeTenant(new URL('https://app.test/signin'));
    expect(getTenant()).toBeNull();
  });

  it.each(['/t/UPPER/agent', '/t', '/t/a/agent', '/agent'])('rejects %s', (path) => {
    expect(resolveTenant(new URL(path, 'https://app.test'))).toBeNull();
  });
});
