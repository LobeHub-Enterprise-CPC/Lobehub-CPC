import { afterEach, describe, expect, it, vi } from 'vitest';

const loadWithBranding = async (name: string) => {
  vi.resetModules();
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    BRANDING_NAME: name,
  }));
  return import('./appAttribution');
};

afterEach(() => {
  vi.doUnmock('@lobechat/business-const');
});

describe('app attribution headers', () => {
  it('keeps the upstream attribution on the stock build', async () => {
    const { aiHubMixAppCodeHeaders, appAttributionHeaders } = await loadWithBranding('LobeHub');

    expect(appAttributionHeaders()).toEqual({
      'HTTP-Referer': 'https://lobehub.com',
      'X-Title': 'LobeHub',
    });
    expect(aiHubMixAppCodeHeaders()).toEqual({ 'APP-Code': 'LobeHub' });
  });

  it('names the distribution and drops vendor attribution on a rebranded build', async () => {
    const { aiHubMixAppCodeHeaders, appAttributionHeaders } = await loadWithBranding('TITU Work');

    expect(appAttributionHeaders()).toEqual({ 'X-Title': 'TITU Work' });
    expect(aiHubMixAppCodeHeaders()).toEqual({});
  });
});
