import { describe, expect, it, vi } from 'vitest';

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  DESKTOP_PROTOCOL_SCHEME: 'tituwork',
}));

const { deviceReconnectUrl } = await import('../deviceReconnectUrl');

describe('deviceReconnectUrl', () => {
  it('opens the scheme registered by the distribution desktop client', () => {
    expect(deviceReconnectUrl('dev 1/2')).toBe('tituwork://device/reconnect?deviceId=dev%201%2F2');
  });
});
