import type { DeviceListItem } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  resolveExecutionDeviceHealth,
  type ResolveExecutionDeviceHealthParams,
} from './executionDeviceHealth';

const device = (overrides: Partial<DeviceListItem>): DeviceListItem =>
  ({
    channels: [],
    defaultCwd: null,
    deviceId: 'dev_remote',
    enroller: null,
    friendlyName: 'Studio Mac',
    hostname: 'studio.local',
    identitySource: null,
    lastSeen: '2026-11-01T00:00:00.000Z',
    online: false,
    ...overrides,
  }) as DeviceListItem;

const local = (
  overrides: Partial<ResolveExecutionDeviceHealthParams> = {},
): ResolveExecutionDeviceHealthParams => ({
  devicesConfirmed: true,
  executionTarget: 'local',
  gatewayStatus: 'disconnected',
  isDesktop: true,
  localRunsThroughGateway: true,
  ...overrides,
});

const remote = (
  overrides: Partial<ResolveExecutionDeviceHealthParams> = {},
): ResolveExecutionDeviceHealthParams => ({
  boundDeviceId: 'dev_remote',
  currentDeviceId: 'dev_local',
  devices: [device({})],
  devicesConfirmed: true,
  executionTarget: 'device',
  gatewayStatus: 'connected',
  isDesktop: true,
  localRunsThroughGateway: true,
  ...overrides,
});

describe('resolveExecutionDeviceHealth', () => {
  describe('local target', () => {
    it('reports a settled outage of this desktop', () => {
      expect(resolveExecutionDeviceHealth(local())).toEqual({
        kind: 'local',
        reconnecting: false,
      });
    });

    it('reports a reconnect loop that outlasted the grace period', () => {
      expect(resolveExecutionDeviceHealth(local({ gatewayStatus: 'reconnecting' }))).toEqual({
        kind: 'local',
        reconnecting: true,
      });
    });

    it.each(['connecting', 'authenticating'] as const)(
      'keeps the local warning visible while the gateway is %s',
      (gatewayStatus) => {
        expect(resolveExecutionDeviceHealth(local({ gatewayStatus }))).toEqual({
          kind: 'local',
          reconnecting: true,
        });
      },
    );

    it.each(['connected'] as const)('stays quiet while the gateway is %s', (gatewayStatus) => {
      expect(resolveExecutionDeviceHealth(local({ gatewayStatus }))).toEqual({ kind: 'ok' });
    });

    it('stays quiet before the first status read lands', () => {
      expect(resolveExecutionDeviceHealth(local({ gatewayStatus: undefined }))).toEqual({
        kind: 'ok',
      });
    });

    it('ignores the gateway when the desktop runs the agent in-process', () => {
      expect(resolveExecutionDeviceHealth(local({ localRunsThroughGateway: false }))).toEqual({
        kind: 'ok',
      });
    });

    it('never reports a local outage on web', () => {
      expect(resolveExecutionDeviceHealth(local({ isDesktop: false }))).toEqual({ kind: 'ok' });
    });
  });

  describe('device target', () => {
    it('reports a bound remote device the server sees offline', () => {
      const offline = device({});

      expect(resolveExecutionDeviceHealth(remote({ devices: [offline] }))).toEqual({
        device: offline,
        kind: 'remote',
      });
    });

    it('stays quiet for an online remote device', () => {
      expect(resolveExecutionDeviceHealth(remote({ devices: [device({ online: true })] }))).toEqual(
        { kind: 'ok' },
      );
    });

    it('does not trust the offline placeholder of a restored row', () => {
      expect(
        resolveExecutionDeviceHealth(remote({ devices: [device({ onlineUnknown: true })] })),
      ).toEqual({ kind: 'ok' });
    });

    it('reports a bound device the confirmed list no longer has', () => {
      expect(resolveExecutionDeviceHealth(remote({ devices: [] }))).toEqual({ kind: 'remote' });
    });

    it('waits for an unconfirmed list before calling a device gone', () => {
      expect(
        resolveExecutionDeviceHealth(remote({ devices: undefined, devicesConfirmed: false })),
      ).toEqual({ kind: 'ok' });
    });

    it("follows this desktop's own connection when bound to this desktop", () => {
      expect(
        resolveExecutionDeviceHealth(
          remote({
            boundDeviceId: 'dev_local',
            devices: [device({ deviceId: 'dev_local', online: true })],
            gatewayStatus: 'disconnected',
          }),
        ),
      ).toEqual({ kind: 'local', reconnecting: false });
    });

    it('treats the same id as remote on web', () => {
      const offline = device({ deviceId: 'dev_local' });

      expect(
        resolveExecutionDeviceHealth(
          remote({ boundDeviceId: 'dev_local', devices: [offline], isDesktop: false }),
        ),
      ).toEqual({ device: offline, kind: 'remote' });
    });
  });

  it.each(['sandbox', 'auto', 'none'] as const)(
    'has nothing to report for the %s target',
    (executionTarget) => {
      expect(resolveExecutionDeviceHealth(remote({ executionTarget }))).toEqual({ kind: 'ok' });
    },
  );
});
