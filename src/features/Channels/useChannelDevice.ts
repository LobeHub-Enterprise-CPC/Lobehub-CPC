import { useState } from 'react';
import useSWR from 'swr';

import type { AvailableAgentItem } from '@/services/agent';
import { deviceService } from '@/services/device';

export function useChannelDevice(
  agents: Pick<AvailableAgentItem, 'heteroType' | 'boundDeviceId'>[],
  existing?: { deviceId?: string; workingDirectory?: string },
) {
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [directories, setDirectories] = useState<Record<string, string>>({});
  const localAgents = agents.filter((agent) =>
    ['codex', 'amp', 'grok-build'].includes(agent.heteroType || ''),
  );
  const boundDevices = new Set(
    [existing?.deviceId, ...localAgents.map((agent) => agent.boundDeviceId)].filter(
      (id): id is string => !!id,
    ),
  );
  const deviceConflict = boundDevices.size > 1;
  const fixedDeviceId = boundDevices.values().next().value;
  const deviceId = fixedDeviceId || selectedDeviceId;
  const needsDevice = !!existing?.deviceId || localAgents.length > 0;
  const { data: devices, error: devicesError } = useSWR(
    needsDevice ? 'channel-devices' : null,
    () => deviceService.listDevices(),
  );
  const device = devices?.find((item) => item.deviceId === deviceId);
  const directory = existing?.workingDirectory ?? directories[deviceId] ?? device?.defaultCwd ?? '';
  return {
    device,
    deviceConflict,
    deviceId,
    devices,
    devicesError,
    directory,
    fixedDeviceId,
    needsDevice,
    ready: !deviceConflict && (!needsDevice || !!(device?.online && directory.trim())),
    setDeviceId: setSelectedDeviceId,
    setDirectory: (value: string) =>
      setDirectories((current) => ({ ...current, [deviceId]: value })),
  };
}
