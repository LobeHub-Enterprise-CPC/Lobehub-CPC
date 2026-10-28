import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OrganizationIdentity from './OrganizationIdentity';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'screen5.identity.organizationWithSlug' && options
        ? `${options.name}（${options.slug}）`
        : key,
  }),
}));

const ENTRY = 'https://work.example.com/t/acme';

afterEach(cleanup);

describe('OrganizationIdentity', () => {
  it('shows "name（slug）" when both are known', () => {
    render(
      <OrganizationIdentity
        account="li@acme.example"
        entryUrl={ENTRY}
        organizationName="Acme Corp"
        organizationSlug="acme"
      />,
    );

    expect(screen.getByText('screen5.identity.organization')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp（acme）')).toBeInTheDocument();
  });

  it('shows only the name when there is no slug', () => {
    render(
      <OrganizationIdentity account="li@acme.example" entryUrl={ENTRY} organizationName="Acme" />,
    );

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.queryByText(/（/)).not.toBeInTheDocument();
  });

  it('shows only the slug when there is no name', () => {
    render(
      <OrganizationIdentity account="li@acme.example" entryUrl={ENTRY} organizationSlug="acme" />,
    );

    expect(screen.getByText('screen5.identity.organization')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.queryByText(/（/)).not.toBeInTheDocument();
  });

  it('omits the organization row when neither is known', () => {
    render(<OrganizationIdentity account="li@acme.example" entryUrl={ENTRY} />);

    expect(screen.queryByText('screen5.identity.organization')).not.toBeInTheDocument();
    expect(screen.getByText(ENTRY)).toBeInTheDocument();
    expect(screen.getByText('li@acme.example')).toBeInTheDocument();
  });
});
