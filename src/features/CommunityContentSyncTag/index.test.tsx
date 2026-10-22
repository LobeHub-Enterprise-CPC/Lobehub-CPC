// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import defaultDiscover from '@/locales/default/discover';

import enUS from '../../../locales/en-US/discover.json';
import zhCN from '../../../locales/zh-CN/discover.json';
import ContentSyncTag from './index';

describe('ContentSyncTag', () => {
  it('tells the viewer a detached resource no longer follows the platform', () => {
    render(<ContentSyncTag contentSync={{ detached: true }} />);

    expect(screen.getByTestId('content-sync-detached')).toHaveTextContent('contentSync.detached');
  });

  // Still synced, never bound, and "Market did not say" are all silence: a tag
  // on every synced copy would be noise on the common case.
  it.each([
    ['still synced', { detached: false }],
    ['no binding', null],
    ['not reported', undefined],
  ])('shows nothing for %s', (_name, contentSync) => {
    const { container } = render(<ContentSyncTag contentSync={contentSync} />);

    expect(screen.queryByTestId('content-sync-detached')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  // The component test above sees keys only; this is the copy a user reads.
  it('ships real copy in the default, en-US and zh-CN locales', () => {
    const key = 'contentSync.detached';
    const sources = {
      'default': (defaultDiscover as Record<string, string>)[key],
      'en-US': (enUS as Record<string, string>)[key],
      'zh-CN': (zhCN as Record<string, string>)[key],
    };

    for (const [, value] of Object.entries(sources)) expect(value).toBeTruthy();
    expect(sources['en-US']).toBe(sources.default);
    expect(sources['zh-CN']).not.toBe(sources['en-US']);
    expect(sources['zh-CN']).toBe('已脱离平台同步');
  });
});
