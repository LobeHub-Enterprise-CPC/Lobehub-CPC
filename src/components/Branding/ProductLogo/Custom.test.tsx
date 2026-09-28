import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CustomLogo from './Custom';

const branding = vi.hoisted(() => ({
  dark: false,
  wordmark: '/light-wordmark.svg',
  darkWordmark: '/dark-wordmark.svg',
}));
vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => branding.dark }));
vi.mock('@lobechat/business-const', () => ({
  BRANDING_NAME: 'Test Brand',
  BRANDING_LOGO_URL: '/light-symbol.png',
  BRANDING_LOGO_DARK_URL: '/dark-symbol.svg',
  BRANDING_TEXT_LOGO_URL: '/light-text.svg',
  BRANDING_TEXT_LOGO_DARK_URL: '/dark-text.svg',
  get BRANDING_WORDMARK_URL() {
    return branding.wordmark;
  },
  get BRANDING_WORDMARK_DARK_URL() {
    return branding.darkWordmark;
  },
}));

beforeEach(() => {
  branding.dark = false;
  branding.wordmark = '/light-wordmark.svg';
  branding.darkWordmark = '/dark-wordmark.svg';
});
afterEach(cleanup);

describe('themed product artwork', () => {
  it('switches the square symbol with the app theme and preserves dimensions', () => {
    const { rerender } = render(<CustomLogo size={28} type="flat" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/light-symbol.png');
    branding.dark = true;
    rerender(<CustomLogo size={29} type="flat" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/dark-symbol.svg');
    expect(screen.getByRole('img')).toHaveAttribute('width', '29');
    expect(screen.getByRole('img')).toHaveAttribute('height', '29');
  });

  it.each(['text', 'combine'] as const)(
    'uses the complete %s wordmark without duplicate text or square stretching',
    (type) => {
      const { rerender } = render(<CustomLogo extra="API" size={32} type={type} />);
      expect(screen.getByRole('img', { name: 'Test Brand' })).toHaveAttribute(
        'src',
        type === 'text' ? '/light-text.svg' : '/light-wordmark.svg',
      );
      expect(screen.getByRole('img')).not.toHaveAttribute('width');
      expect(screen.queryByText('Test Brand')).toBeNull();
      expect(screen.getByText('API')).toBeInTheDocument();
      branding.dark = true;
      rerender(<CustomLogo extra="API" size={33} type={type} />);
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        type === 'text' ? '/dark-text.svg' : '/dark-wordmark.svg',
      );
    },
  );

  it('falls back to the light wordmark when no dark variant is supplied', () => {
    branding.dark = true;
    branding.darkWordmark = '';
    render(<CustomLogo type="combine" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/light-wordmark.svg');
  });

  it('preserves symbol-plus-name for distributions without a wordmark', () => {
    branding.wordmark = '';
    render(<CustomLogo type="combine" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/light-symbol.png');
    expect(screen.getByText('Test Brand')).toBeInTheDocument();
  });
});
