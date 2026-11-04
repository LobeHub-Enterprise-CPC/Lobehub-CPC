import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tryGatewayAutoConnect, watchSystemWake } from '../gatewayAutoConnect';

const gatewayAlwaysOn = vi.hoisted(() => ({ value: false }));
const wakeHandlers = vi.hoisted(() => new Map<string, () => void>());

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get DESKTOP_DEVICE_GATEWAY_ALWAYS_ON() {
    return gatewayAlwaysOn.value;
  },
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app', getPath: () => '/mock', getVersion: () => '0-test' },
  powerMonitor: {
    on: vi.fn((event: string, handler: () => void) => wakeHandlers.set(event, handler)),
  },
}));

const deps = (overrides: Partial<Parameters<typeof tryGatewayAutoConnect>[0]> = {}) => ({
  connect: vi.fn(async () => undefined),
  gatewayEnabled: () => true as boolean | undefined,
  getAccessToken: async () => 'login-token' as string | null,
  isRemoteServerConfigured: async () => true,
  ...overrides,
});

beforeEach(() => {
  gatewayAlwaysOn.value = false;
  wakeHandlers.clear();
});

describe('tryGatewayAutoConnect', () => {
  it('connects a switched-on device with a login', async () => {
    const d = deps();
    await tryGatewayAutoConnect(d);
    expect(d.connect).toHaveBeenCalledOnce();
  });

  it.each([
    ['the device is switched off', { gatewayEnabled: () => false }],
    ['no remote server is configured', { isRemoteServerConfigured: async () => false }],
    ['there is no access token', { getAccessToken: async () => null }],
  ])('skips when %s', async (_reason, overrides) => {
    const d = deps(overrides);
    await tryGatewayAutoConnect(d);
    expect(d.connect).not.toHaveBeenCalled();
  });

  it('still connects an always-on build whose gatewayEnabled is false', async () => {
    gatewayAlwaysOn.value = true;
    const d = deps({ gatewayEnabled: () => false });
    await tryGatewayAutoConnect(d);
    expect(d.connect).toHaveBeenCalledOnce();
  });
});

// After sleep the old socket can look open for ~2 minutes, and a device that
// gave up while offline has no client left.
describe('watchSystemWake', () => {
  it.each(['resume', 'unlock-screen'])('reconnects the live connection on %s', (event) => {
    const reconnect = vi.fn(() => true);
    const autoConnect = vi.fn();
    watchSystemWake(reconnect, autoConnect);
    wakeHandlers.get(event)!();
    expect(reconnect).toHaveBeenCalledOnce();
    expect(autoConnect).not.toHaveBeenCalled();
  });

  it('connects the way start-up does when no connection is left', () => {
    const autoConnect = vi.fn();
    watchSystemWake(() => false, autoConnect);
    wakeHandlers.get('resume')!();
    expect(autoConnect).toHaveBeenCalledOnce();
  });
});
