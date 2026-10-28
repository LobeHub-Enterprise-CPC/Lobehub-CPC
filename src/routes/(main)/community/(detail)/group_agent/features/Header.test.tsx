// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { DetailProvider } from './DetailProvider';
import Header from './Header';

vi.mock('./GroupAgentForkTag', () => ({ default: () => null }));
vi.mock('@/features/Workspace/WorkspaceLink', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/layout/AuthProvider/MarketAuth', () => ({
  useMarketAuth: () => ({ isAuthenticated: false, session: undefined, signIn: vi.fn() }),
}));

const renderHeader = (config: Record<string, unknown>) =>
  render(
    <MemoryRouter>
      <DetailProvider
        config={{
          createdAt: '2026-01-01',
          identifier: 'g1',
          memberAgents: [],
          title: 'G',
          ...config,
        }}
      >
        <Header />
      </DetailProvider>
    </MemoryRouter>,
  );

describe('community group detail Header: platform sync state', () => {
  it('marks a group that was detached from platform sync', () => {
    renderHeader({ contentSync: { detached: true } });

    expect(screen.getByTestId('content-sync-detached')).toBeInTheDocument();
  });

  it.each([
    ['still synced', { contentSync: { detached: false } }],
    ['no binding', { contentSync: null }],
    ['not reported', {}],
  ])('says nothing for %s', (_name, config) => {
    renderHeader(config);

    expect(screen.queryByTestId('content-sync-detached')).toBeNull();
  });
});
