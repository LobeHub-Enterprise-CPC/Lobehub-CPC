import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';

interface DeviceArchitectureBackfillOptions {
  architecture: string;
  deviceId: string;
  headers: Record<string, string>;
  serverUrl: string;
}

export const backfillDeviceArchitecture = async ({
  architecture,
  deviceId,
  headers,
  serverUrl,
}: DeviceArchitectureBackfillOptions): Promise<void> => {
  const response = await fetch(
    buildRemoteUrl('/trpc/lambda/device.listDevices', serverUrl).toString(),
    {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error(`Device registry read failed: HTTP ${response.status}`);

  const payload = await response.json();
  const devices = payload?.result?.data?.json;
  if (!Array.isArray(devices)) return;

  const device = devices.find(
    (item) => item.deviceId === deviceId && item.scope === 'personal' && item.registered,
  );
  if (!device || device.architecture) return;

  const updated = await fetch(
    buildRemoteUrl('/trpc/lambda/device.updateDeviceInfo', serverUrl).toString(),
    {
      body: JSON.stringify({
        json: { architecture, deviceId },
      }),
      headers,
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!updated.ok) throw new Error(`Device architecture backfill failed: HTTP ${updated.status}`);
};
