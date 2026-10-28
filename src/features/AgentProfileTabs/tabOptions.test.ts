import type * as BusinessConst from '@lobechat/business-const';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentProfileTabOptions, buildAgentProfileTabPath } from './tabOptions';

// Pin the flag rather than inherit it: `buildAgentProfileTabOptions` reads
// EXTERNAL_INTEGRATIONS_ENABLED, so a distribution that ships no messengers
// would otherwise flip the cases below out from under them. The deployment
// gate is covered separately below.
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  EXTERNAL_INTEGRATIONS_ENABLED: true,
}));

const labels = {
  channel: 'tab.integration',
  profile: 'tab.profile',
  share: 'share',
  statistics: 'usageStats.title',
};

describe('buildAgentProfileTabPath', () => {
  it('builds the sub-route of the agent', () => {
    expect(buildAgentProfileTabPath('agt_1', 'statistics')).toBe('/agent/agt_1/statistics');
  });
});

describe('buildAgentProfileTabOptions', () => {
  it('lists the full group for a member who can configure the agent', () => {
    const options = buildAgentProfileTabOptions({
      active: 'profile',
      canConfigure: true,
      labels,
      shareSupported: true,
    });

    expect(options.map((option) => option.value)).toEqual([
      'profile',
      'channel',
      'statistics',
      'share',
    ]);
  });

  it('allows configuring channels even when the agent needs a device to execute', () => {
    const options = buildAgentProfileTabOptions({
      active: 'profile',
      canConfigure: true,
      labels,
      shareSupported: false,
    });

    expect(options.map((option) => option.value)).toEqual(['profile', 'channel', 'statistics']);
  });

  it('drops the config tabs for a member without edit access', () => {
    const options = buildAgentProfileTabOptions({
      active: 'statistics',
      canConfigure: false,
      labels,
      shareSupported: true,
    });

    expect(options.map((option) => option.value)).toEqual(['statistics']);
  });

  it('keeps the tab owned by the current page even when it is gated off', () => {
    const options = buildAgentProfileTabOptions({
      active: 'channel',
      canConfigure: false,
      labels,
      shareSupported: false,
    });

    expect(options.map((option) => option.value)).toEqual(['channel', 'statistics']);
  });

  it('drops share when the agent cannot be shared at all', () => {
    const options = buildAgentProfileTabOptions({
      active: 'profile',
      canConfigure: true,
      labels,
      shareSupported: false,
    });

    expect(options.map((option) => option.value)).toEqual(['profile', 'channel', 'statistics']);
  });

  it('keeps share when it owns the current page even though it is gated off', () => {
    const options = buildAgentProfileTabOptions({
      active: 'share',
      canConfigure: false,
      labels,
      shareSupported: false,
    });

    expect(options.map((option) => option.value)).toEqual(['statistics', 'share']);
  });

  // Channels are the external-messenger surface, so where a distribution ships
  // none of them the segment must not be offered for any agent — the route
  // itself bounces back out in that case.
  it('drops the channel segment where the distribution ships no external integrations', async () => {
    vi.resetModules();
    vi.doMock('@lobechat/business-const', async (importOriginal) => ({
      ...(await importOriginal<typeof BusinessConst>()),
      EXTERNAL_INTEGRATIONS_ENABLED: false,
    }));

    const { buildAgentProfileTabOptions: withoutIntegrations } = await import('./tabOptions');

    const options = withoutIntegrations({
      active: 'profile',
      canConfigure: true,
      labels,
      shareSupported: true,
    });

    expect(options.map((option) => option.value)).toEqual(['profile', 'statistics', 'share']);

    vi.doUnmock('@lobechat/business-const');
    vi.resetModules();
  });
});
