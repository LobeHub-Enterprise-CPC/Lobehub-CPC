import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import { useCategory } from '../features/useCategory';

const { download } = vi.hoisted(() => ({
  download: { available: false, href: undefined as string | undefined },
}));
vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_NAME: 'Private Workspace',
  BRANDING_EMAIL: { support: 'support@private.example' },
}));
vi.mock('@/features/Downloads/useDesktopDownload', () => ({ useDesktopDownload: () => download }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ServerConfigStoreProvider>{children}</ServerConfigStoreProvider>
);
afterEach(() => {
  download.available = false;
  download.href = undefined;
  vi.restoreAllMocks();
});
describe('private mobile help', () => {
  it('hides upstream downloads, docs, cloud promotion and changelog even when feature flags allow them', () => {
    const { result } = renderHook(useCategory, { wrapper });
    const keys = result.current.map((i) => i.key);
    expect(keys).not.toEqual(expect.arrayContaining(['docs']));
    for (const key of ['get-desktop-app', 'docs', 'cloud', 'changelog'])
      expect(keys).not.toContain(key);
    expect(keys).toContain('feedback');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => result.current.find((i) => i.key === 'feedback')?.onClick?.());
    expect(open).toHaveBeenCalledWith('mailto:support@private.example', '__blank');
  });
  it('uses only the deployment download page when installers exist', () => {
    download.available = true;
    download.href = '/downloads';
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(useCategory, { wrapper });
    act(() => result.current.find((i) => i.key === 'get-desktop-app')?.onClick?.());
    expect(open).toHaveBeenCalledWith('/downloads', '__blank');
  });
});
