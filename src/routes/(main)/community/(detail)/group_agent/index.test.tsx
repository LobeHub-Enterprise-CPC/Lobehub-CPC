// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import GroupAgentDetailPage from './index';

const mocks = vi.hoisted(() => ({ detail: undefined as unknown, error: undefined as unknown }));

vi.mock('@/hooks/useQuery', () => ({ useQuery: () => ({}) }));
vi.mock('@/store/discover', () => ({
  useDiscoverStore: (selector: (state: any) => unknown) =>
    selector({
      useFetchGroupAgentDetail: () => ({ error: mocks.error, isLoading: false, queryKey: 'k' }),
    }),
}));
vi.mock('@/store/discover/selectors', () => ({
  groupAgentSelectors: { groupAgentDetail: () => () => mocks.detail },
}));
vi.mock('../features/Toc/useToc', () => ({
  TocProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/NotFound', () => ({ default: () => <div data-testid="not-found" /> }));
vi.mock('@/components/AsyncError', () => ({ default: () => <div data-testid="async-error" /> }));
vi.mock('./features/Details', () => ({ default: () => null }));
vi.mock('./features/StatusPage', () => ({ default: () => null }));
// The header itself is covered where it is drawn; here only what reaches it.
vi.mock('./features/Header', async () => {
  const { useDetailContext } = await import('./features/DetailProvider');
  const SeenHeader = () => {
    const { contentSync } = useDetailContext();
    return (
      <div data-testid="seen">
        {contentSync === undefined ? 'absent' : JSON.stringify(contentSync)}
      </div>
    );
  };
  return { default: SeenHeader };
});

const renderPage = (detail: unknown, error?: unknown) => {
  mocks.detail = detail;
  mocks.error = error;
  render(
    <MemoryRouter initialEntries={['/community/group_agent/g1']}>
      <Routes>
        <Route element={<GroupAgentDetailPage />} path="/community/group_agent/:slug" />
      </Routes>
    </MemoryRouter>,
  );
};

describe('GroupAgentDetailPage contentSync', () => {
  it.each([
    ['detached', { detached: true }],
    ['still synced', { detached: false }],
    ['no binding', null],
  ])('reads the %s state from .group', (_name, contentSync) => {
    renderPage({ group: { contentSync, identifier: 'g1', status: 'published' } });

    expect(screen.getByTestId('seen')).toHaveTextContent(JSON.stringify(contentSync));
  });

  it('does not read it from the envelope', () => {
    renderPage({
      contentSync: { detached: true },
      group: { identifier: 'g1', status: 'published' },
    });

    expect(screen.getByTestId('seen')).toHaveTextContent('absent');
  });
});

describe('GroupAgentDetailPage failures', () => {
  it('renders the not-found state when Market answers NOT_FOUND', () => {
    renderPage(undefined, { data: { code: 'NOT_FOUND' } });

    expect(screen.getByTestId('not-found')).toBeInTheDocument();
  });

  it('keeps the error state for other failures', () => {
    renderPage(undefined, { data: { code: 'INTERNAL_SERVER_ERROR' } });

    expect(screen.getByTestId('async-error')).toBeInTheDocument();
  });
});
