import { DESKTOP_PROTOCOL_SCHEME } from '@lobechat/business-const';

/**
 * Deep link that asks the desktop client owning `deviceId` to reconnect its
 * gateway. Uses the scheme this distribution's desktop client registers, so the
 * browser hands it to that client rather than to another vendor's install.
 */
export const deviceReconnectUrl = (deviceId: string) =>
  `${DESKTOP_PROTOCOL_SCHEME}://device/reconnect?deviceId=${encodeURIComponent(deviceId)}`;
