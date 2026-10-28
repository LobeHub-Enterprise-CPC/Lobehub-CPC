import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import Link from './Link';

const renderUnder = (href: string) =>
  render(
    <MemoryRouter basename="/orgs/acme" initialEntries={['/orgs/acme/agent']}>
      <Link href={href}>link</Link>
    </MemoryRouter>,
  );

describe('Link', () => {
  it('resolves an app path under the tenant the router is mounted at', () => {
    renderUnder('/agent/x');
    expect(screen.getByText('link').getAttribute('href')).toBe('/orgs/acme/agent/x');
  });

  // A path that already names a tenant (this one, a former slug of it, or another) is not an app
  // path: the router basename must not be put in front of it a second time.
  it.each(['/orgs/acme/f/file_1', '/orgs/acme-old/f/file_1', '/t/acme-old/f/file_1'])(
    'keeps %s as it is',
    (href) => {
      renderUnder(href);
      expect(screen.getByText('link').getAttribute('href')).toBe(href);
    },
  );
});
