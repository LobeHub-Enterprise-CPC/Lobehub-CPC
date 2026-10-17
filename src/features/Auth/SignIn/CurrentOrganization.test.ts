import { describe, expect, it } from 'vitest';

import { organizationLabelOf } from './CurrentOrganization';

describe('organizationLabelOf', () => {
  it('shows the directory name next to the slug', () => {
    expect(organizationLabelOf({ name: 'Acme Inc.', slug: 'acme' })).toEqual({
      key: 'organization.current.named',
      values: { name: 'Acme Inc.', slug: 'acme' },
    });
  });

  it.each([undefined, '', 'acme'])('falls back to the slug alone for name %j', (name) => {
    expect(organizationLabelOf({ name, slug: 'acme' })).toEqual({
      key: 'organization.current.slugOnly',
      values: { slug: 'acme' },
    });
  });
});
