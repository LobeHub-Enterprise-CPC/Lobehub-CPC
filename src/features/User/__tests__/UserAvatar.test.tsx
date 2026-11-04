import { BRANDING_NAME } from '@lobechat/business-const';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ConstMetaModule from '@/const/meta';
import { DEFAULT_USER_AVATAR_URL } from '@/const/meta';
import { useUserStore } from '@/store/user';

import UserAvatar from '../UserAvatar';

const brand = vi.hoisted(() => ({ userAvatar: undefined as string | undefined }));

vi.mock('@/const/meta', async (importOriginal) => ({
  ...(await importOriginal<typeof ConstMetaModule>()),
  get BRANDED_USER_AVATAR() {
    return brand.userAvatar;
  },
}));

describe('UserAvatar', () => {
  afterEach(() => {
    brand.userAvatar = undefined;
  });

  it('should show the username and avatar are displayed when the user is logged in', async () => {
    const mockAvatar = 'https://example.com/avatar.png';
    const mockUsername = 'teeeeeestuser';

    act(() => {
      useUserStore.setState({
        isSignedIn: true,
        user: { avatar: mockAvatar, id: 'abc', username: mockUsername },
      });
    });

    render(<UserAvatar />);

    expect(screen.getByAltText(mockUsername)).toBeInTheDocument();
    expect(screen.getByAltText(mockUsername)).toHaveAttribute('src', mockAvatar);
  });

  it('should show default avatar when the user is logged in but have no custom avatar', () => {
    const mockUsername = 'testuser';

    act(() => {
      useUserStore.setState({
        isSignedIn: true,
        user: { id: 'bbb', username: mockUsername },
      });
    });

    const { container } = render(<UserAvatar />);
    // Without an avatar url, <Avatar /> draws a fallback for the name instead of an <img />:
    // initials in older @lobehub/ui, a generated image labelled with the name in newer ones.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.lobe-avatar')).toBeInTheDocument();
  });

  it("shows the distribution's avatar instead of initials when a signed-in user has none", () => {
    brand.userAvatar = '/brand/user-avatar.png';
    act(() => {
      useUserStore.setState({ isSignedIn: true, user: { id: 'ccc', username: 'nophoto' } });
    });

    render(<UserAvatar />);

    expect(screen.getByAltText('nophoto')).toHaveAttribute('src', '/brand/user-avatar.png');
    expect(screen.queryByText('NO')).not.toBeInTheDocument();
  });

  it('should show LobeChat and default avatar when the user is not logged in', () => {
    act(() => {
      useUserStore.setState({ isSignedIn: false, user: undefined });
    });

    render(<UserAvatar />);
    expect(screen.getByAltText(BRANDING_NAME)).toBeInTheDocument();
    expect(screen.getByAltText(BRANDING_NAME)).toHaveAttribute('src', DEFAULT_USER_AVATAR_URL);
  });
});
