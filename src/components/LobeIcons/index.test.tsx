import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProviderCombine, ProviderIcon } from './index';

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BRANDING_LOGO_URL: '/branding/private-logo.png',
  BRANDING_NAME: 'Private Workspace',
  BRANDING_PROVIDER: 'lobehub',
}));

// Warm the real catalog before the DOM query timeout; a cold transform is not
// a rendering failure. The public lazy components themselves are not mocked.
beforeAll(() => import('@/libs/providerIcon'), 30_000);
afterEach(cleanup);

describe('public provider artwork entry points', () => {
  it.each(['lobehub', 'LobeHub'])('brands the %s API-key error icon', async (provider) => {
    const { container } = render(<ProviderIcon provider={provider} shape="square" size={40} />);

    const logo = await screen.findByRole('img', { name: 'Private Workspace' });
    expect(logo).toHaveAttribute('src', '/branding/private-logo.png');
    expect(logo).toHaveAttribute('width', '40');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('brands combined provider artwork as well as standalone icons', async () => {
    const { container } = render(<ProviderCombine provider="lobehub" size={24} />);

    expect(await screen.findByRole('img', { name: 'Private Workspace' })).toHaveAttribute(
      'src',
      '/branding/private-logo.png',
    );
    expect(screen.getByText('Private Workspace')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });
});
