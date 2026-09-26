import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CheckError } from './CheckError';

vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_NAME: 'Private Workspace',
}));
afterEach(cleanup);
it('keeps the error but offers no upstream setup link in private builds', () => {
  render(
    <CheckError
      defaultError={<span>Connection failed</span>}
      error={{ message: 'failure' } as any}
      setError={vi.fn()}
    />,
  );
  expect(screen.getByText('Connection failed')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
