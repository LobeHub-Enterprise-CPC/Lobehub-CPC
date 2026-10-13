import type * as LobechatConstModule from '@lobechat/const';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useElectronStore } from '@/store/electron';
import { useUserStore } from '@/store/user';

import { useUserAvatar } from './useUserAvatar';

const mockConstEnv = vi.hoisted(() => ({ isDesktop: false }));

vi.mock('@lobechat/const', async (importOriginal) => {
  const actual = await importOriginal<typeof LobechatConstModule>();
  return {
    ...actual,
    get isDesktop() {
      return mockConstEnv.isDesktop;
    },
    DEFAULT_USER_AVATAR: 'default-avatar.png',
    OFFICIAL_URL: 'https://app.lobehub.com',
  };
});

describe('useUserAvatar', () => {
  it('should return default avatar when user has no avatar', () => {
    act(() => {
      useUserStore.setState({ user: { avatar: undefined } as any });
    });

    const { result } = renderHook(() => useUserAvatar());

    expect(result.current).toBe('default-avatar.png');
  });

  it('should return user avatar when available', () => {
    const mockAvatar = 'https://example.com/avatar.png';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
    });

    const { result } = renderHook(() => useUserAvatar());

    expect(result.current).toBe(mockAvatar);
  });

  it('should return original avatar in non-desktop environment', () => {
    mockConstEnv.isDesktop = false;
    const mockAvatar = '/api/avatar.png';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl: 'https://server.com', storageMode: 'cloud' },
      });
    });

    const { result } = renderHook(() => useUserAvatar());

    expect(result.current).toBe(mockAvatar);
  });

  it('should return original avatar when no remote server URL in desktop environment (selfHost mode)', () => {
    mockConstEnv.isDesktop = true;
    const mockAvatar = '/api/avatar.png';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl: undefined, storageMode: 'selfHost' },
      });
    });

    const { result } = renderHook(() => useUserAvatar());

    expect(result.current).toBe(mockAvatar);
  });

  it('should prepend remote server URL when avatar starts with / in desktop environment (selfHost mode)', () => {
    mockConstEnv.isDesktop = true;
    const mockAvatar = '/api/avatar.png';
    const mockServerUrl = 'https://server.com';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl: mockServerUrl, storageMode: 'selfHost' },
      });
    });

    const { result } = renderHook(() => useUserAvatar());

    expect(result.current).toBe('https://server.com/api/avatar.png');
  });

  it('should not prepend remote server URL when avatar does not start with / in desktop environment', () => {
    mockConstEnv.isDesktop = true;
    const mockAvatar = 'https://example.com/avatar.png';
    const mockServerUrl = 'https://server.com';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl: mockServerUrl, storageMode: 'selfHost' },
      });
    });

    const { result } = renderHook(() => useUserAvatar());

    expect(result.current).toBe(mockAvatar);
  });

  it('should use OFFICIAL_URL when storageMode is cloud in desktop environment', () => {
    mockConstEnv.isDesktop = true;
    const mockAvatar = '/api/avatar.png';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl: '', storageMode: 'cloud' },
      });
    });

    const { result } = renderHook(() => useUserAvatar());

    // In cloud mode, selector returns OFFICIAL_URL regardless of remoteServerUrl config
    expect(result.current).toBe('https://app.lobehub.com/api/avatar.png');
  });

  it('should return original avatar when storageMode is selfHost but no URL configured', () => {
    mockConstEnv.isDesktop = true;
    const mockAvatar = '/api/avatar.png';

    act(() => {
      useUserStore.setState({ user: { avatar: mockAvatar } as any });
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl: '', storageMode: 'selfHost' },
      });
    });

    const { result } = renderHook(() => useUserAvatar());

    // In selfHost mode with empty URL, avatar is not prepended
    expect(result.current).toBe(mockAvatar);
  });

  describe('tenant address (desktop, selfHost mode)', () => {
    const renderAvatar = (avatar: string, remoteServerUrl: string) => {
      mockConstEnv.isDesktop = true;
      act(() => {
        useUserStore.setState({ user: { avatar } as any });
        useElectronStore.setState({
          dataSyncConfig: { remoteServerUrl, storageMode: 'selfHost' },
        });
      });

      return renderHook(() => useUserAvatar()).result.current;
    };

    it('keeps the tenant path prefix of the remote server address', () => {
      expect(renderAvatar('/webapi/user/avatar/u1/a.png', 'https://host/t/acme')).toBe(
        'https://host/t/acme/webapi/user/avatar/u1/a.png',
      );
    });

    it('does not double the slash of an address entered with a trailing slash', () => {
      expect(renderAvatar('/webapi/user/avatar/u1/a.png', 'https://host/t/acme/')).toBe(
        'https://host/t/acme/webapi/user/avatar/u1/a.png',
      );
    });

    it('resolves against the root of a custom-domain address', () => {
      expect(renderAvatar('/webapi/user/avatar/u1/a.png', 'https://custom.host/')).toBe(
        'https://custom.host/webapi/user/avatar/u1/a.png',
      );
    });

    it('does not prefix an avatar path the server already prefixed', () => {
      expect(renderAvatar('/t/acme/webapi/user/avatar/u1/a.png', 'https://host/t/acme')).toBe(
        'https://host/t/acme/webapi/user/avatar/u1/a.png',
      );
    });

    it('uses an absolute avatar url as is', () => {
      expect(renderAvatar('https://cdn.example.com/a.png', 'https://host/t/acme')).toBe(
        'https://cdn.example.com/a.png',
      );
    });

    it('never turns a protocol-relative avatar into a link on the remote server', () => {
      expect(renderAvatar('//cdn.example.com/a.png', 'https://host/t/acme')).toBe(
        '//cdn.example.com/a.png',
      );
    });
  });
});
