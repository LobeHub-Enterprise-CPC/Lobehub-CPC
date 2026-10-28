import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Layout from './index';

let showMarket: boolean | undefined = true;
let showcase = false;

// Pinned so the suite tests the layout, not the deployment it runs in.
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get COMMUNITY_SHOWCASE_LAYOUT() {
    return showcase;
  },
}));

vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: (state: { featureFlags: unknown }) => state.featureFlags,
  useServerConfigStore: (selector: (state: { featureFlags: unknown }) => unknown) =>
    selector({ featureFlags: { showMarket } }),
}));

vi.mock('./Sidebar', () => ({ default: () => <div data-testid={'community-sidebar'} /> }));
vi.mock('./style', () => ({ styles: { mainContainer: '' } }));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<div data-testid={'home'} />} path={'/'} />
        <Route element={<Layout />} path={'/community/*'}>
          <Route element={<div data-testid={'agent-list'} />} path={'agent'} />
          <Route element={<div data-testid={'mcp-detail'} />} path={'mcp/:slug'} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

describe('community layout', () => {
  beforeEach(() => {
    showMarket = true;
    showcase = false;
  });

  it('renders the section when the market flag is on', () => {
    renderAt('/community');

    expect(screen.getByTestId('community-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('home')).not.toBeInTheDocument();
  });

  it('redirects to home when the market flag is off', () => {
    showMarket = false;
    renderAt('/community');

    expect(screen.getByTestId('home')).toBeInTheDocument();
    expect(screen.queryByTestId('community-sidebar')).not.toBeInTheDocument();
  });

  // The nav entry is hidden by the same flag, so the only way in is a typed URL
  // or a stale link — and those land on a nested path, not the section root.
  it('redirects from a nested community route too', () => {
    showMarket = false;
    renderAt('/community/mcp/some-plugin');

    expect(screen.getByTestId('home')).toBeInTheDocument();
  });

  // Matches how the nav reads the same flag (`hidden: !showMarket`). The server
  // merges over `DEFAULT_FEATURE_FLAGS.market = true`, so an unset flag never
  // reaches here as undefined — but if it ever did, nav and route must agree.
  it('treats an unset flag the same way the nav does', () => {
    showMarket = undefined;
    renderAt('/community');

    expect(screen.getByTestId('home')).toBeInTheDocument();
  });

  describe('showcase market', () => {
    beforeEach(() => {
      showcase = true;
    });

    it('drops the section sidebar', () => {
      renderAt('/community/agent');

      expect(screen.getByTestId('agent-list')).toBeInTheDocument();
      expect(screen.queryByTestId('community-sidebar')).not.toBeInTheDocument();
    });

    it.each(['/community', '/community/model', '/community/provider/openai'])(
      'sends %s to the assistant list',
      (path) => {
        renderAt(path);

        expect(screen.getByTestId('agent-list')).toBeInTheDocument();
      },
    );

    it('keeps connector pages', () => {
      renderAt('/community/mcp/some-plugin');

      expect(screen.getByTestId('mcp-detail')).toBeInTheDocument();
    });
  });
});
