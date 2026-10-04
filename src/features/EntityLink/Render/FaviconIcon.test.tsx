import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { isCustomBranding } from '@/const/version';

import FaviconIcon from './FaviconIcon';

// jsdom serves the tests from http://localhost/
const SAME_ORIGIN_DOMAIN = 'localhost';

describe('FaviconIcon', () => {
  it("uses the deployment's own favicon for same-origin links", () => {
    const { container } = render(<FaviconIcon domain={SAME_ORIGIN_DOMAIN} />);

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/favicon.ico');
  });

  it('treats a leading www. as the same origin', () => {
    const { container } = render(<FaviconIcon domain={`www.${SAME_ORIGIN_DOMAIN}`} />);

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/favicon.ico');
  });

  it('never asks a third party about external domains under custom branding', () => {
    const { container } = render(<FaviconIcon domain={'thecoffee.club'} />);
    const src = container.querySelector('img')?.getAttribute('src');

    if (isCustomBranding) {
      // private deployment: globe glyph, no outbound request
      expect(src).toBeUndefined();
      expect(container.querySelector('svg')).toBeTruthy();
    } else {
      expect(src).toBe('https://icons.duckduckgo.com/ip3/thecoffee.club.ico');
    }
  });
});
