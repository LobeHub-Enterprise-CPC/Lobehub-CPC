// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { DetailProvider } from './DetailProvider';
import Header from './Header';

vi.mock('@/layout/AuthProvider/MarketAuth', () => ({
  useMarketAuth: () => ({ isAuthenticated: false, session: undefined, signIn: vi.fn() }),
}));
vi.mock('@/hooks/useMCPCategory', () => ({ useCategoryItem: () => undefined }));
vi.mock('@/features/MCP/Scores', () => ({ default: () => null }));

const renderHeader = (config: Record<string, unknown>) =>
  render(
    <MemoryRouter>
      <DetailProvider
        config={{
          author: { name: 'A' },
          createdAt: '2026-01-01',
          identifier: 'mcp-1',
          name: 'MCP',
          version: '1.0.0',
          ...config,
        }}
      >
        <Header />
      </DetailProvider>
    </MemoryRouter>,
  );

describe('community MCP detail Header: platform sync state', () => {
  it('marks a copy that was detached from platform sync', () => {
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
