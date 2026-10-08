import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import PluginTag from './PluginTag';

vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_NAME: 'Private Workspace',
}));
afterEach(cleanup);
it('brands the builtin author while preserving third-party attribution', () => {
  render(
    <>
      <PluginTag author="LobeHub" type="builtin" />
      <PluginTag author="Example Developer" type="plugin" />
    </>,
  );
  expect(screen.getByText('Private Workspace')).toBeTruthy();
  expect(screen.getByText('Example Developer')).toBeTruthy();
  expect(screen.queryByText('LobeHub')).toBeNull();
});
