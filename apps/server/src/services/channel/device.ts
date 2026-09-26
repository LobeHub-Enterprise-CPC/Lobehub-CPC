import type {
  CodexChannelSnapshot,
  CodexChannelStart,
} from '@lobechat/heterogeneous-agents/channel';
import type { ChannelRuntime } from '@lobechat/types';

import { DeviceModel } from '@/database/models/device';
import type { LobeChatDatabase } from '@/database/type';
import { assertWorkspaceRootApproved } from '@/server/routers/lambda/deviceWorkspaceGuard';
import { deviceGateway } from '@/server/services/deviceGateway';

/** Only this server adapter supplies the owner and native Run authority. */
export class ChannelDevice {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly ownerId: string,
    private readonly deviceId: string,
  ) {}

  private async call<T>(apiName: string, input: Record<string, unknown>): Promise<T> {
    const device = await new DeviceModel(this.db, this.ownerId).findByDeviceId(this.deviceId);
    if (!device || device.workspaceId) throw new Error('Personal execution device is unavailable');
    const result = await deviceGateway.executeToolCall(
      { userId: this.ownerId, deviceId: this.deviceId },
      {
        identifier: 'local',
        apiName,
        arguments: JSON.stringify({ ...input, ownerId: this.ownerId }),
      },
      10_000,
    );
    if (!result.success) throw new Error(result.error || 'Channel Desktop adapter is unavailable');
    return JSON.parse(result.content) as T;
  }

  async probe(cwd: string, runtime: ChannelRuntime = 'codex') {
    const model = new DeviceModel(this.db, this.ownerId);
    await assertWorkspaceRootApproved(model, this.deviceId, cwd);
    const result = await this.call<{ available: boolean; canonicalPath: string; protocol: string }>(
      'channelProbe',
      { cwd, runtime: runtime === 'native' ? 'codex' : runtime },
    );
    if (!result.available || result.protocol !== 'channel-v1')
      throw new Error('This Desktop does not support Channel execution');
    // A directory explicitly selected by the owner may itself be an alias (for
    // example /tmp on macOS). The device resolves that approved root. Nested
    // paths still need the canonical guard so a symlink cannot escape a root.
    const device = await model.findByDeviceId(this.deviceId);
    const explicitRoots = [
      device?.defaultCwd,
      ...(device?.workingDirs ?? []).map((dir) => dir.path),
    ];
    if (!explicitRoots.includes(cwd)) {
      await assertWorkspaceRootApproved(model, this.deviceId, result.canonicalPath);
    } else if (!explicitRoots.includes(result.canonicalPath)) {
      // Runs and subsequent member additions use the canonical directory.
      await model.update(this.deviceId, {
        workingDirs: [{ path: result.canonicalPath }, ...(device?.workingDirs ?? [])].slice(0, 20),
      });
    }
    return result.canonicalPath;
  }

  start(input: Omit<CodexChannelStart, 'ownerId'>) {
    return this.call<CodexChannelSnapshot>('channelStart', input);
  }
  inspect(runId: string, fence: number) {
    return this.call<CodexChannelSnapshot | null>('channelInspect', { runId, fence });
  }
  stop(runId: string, fence: number) {
    return this.call<CodexChannelSnapshot | null>('channelStop', { runId, fence });
  }
  approve(runId: string, fence: number, approvalId: string, approved: boolean) {
    return this.call<void>('channelApprove', { runId, fence, approvalId, approved });
  }
}
