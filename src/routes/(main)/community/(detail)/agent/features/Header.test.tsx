// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import Header from './Header';

const mocks = vi.hoisted(() => ({ detail: {} as Record<string, unknown> }));

vi.mock('./DetailProvider', () => ({ useDetailContext: () => mocks.detail }));
vi.mock('./AgentForkTag', () => ({ default: () => null }));
vi.mock('@/features/Workspace/WorkspaceLink', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/layout/AuthProvider/MarketAuth', () => ({
  useMarketAuth: () => ({ isAuthenticated: false, session: undefined, signIn: vi.fn() }),
}));
vi.mock('../../../(list)/agent/features/Category/useCategory', () => ({ useCategory: () => [] }));

const renderHeader = (detail: Record<string, unknown>) => {
  mocks.detail = { author: 'A', createdAt: '2026-01-01', identifier: 'a1', title: 'T', ...detail };
  render(
    <MemoryRouter>
      <Header />
    </MemoryRouter>,
  );
};

describe('community agent detail Header: platform sync state', () => {
  it('marks a copy that was detached from platform sync', () => {
    renderHeader({ contentSync: { detached: true } });

    expect(screen.getByTestId('content-sync-detached')).toBeInTheDocument();
  });

  it.each([
    ['still synced', { contentSync: { detached: false } }],
    ['no binding', { contentSync: null }],
    ['not reported', {}],
  ])('says nothing for %s', (_name, detail) => {
    renderHeader(detail);

    expect(screen.queryByTestId('content-sync-detached')).toBeNull();
  });
});
