import type * as DeviceControlModule from '@lobechat/device-control';
import { GatewayClient } from '@lobechat/device-gateway-client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as GatewayIdentityModule from '../auth/gatewayIdentity';
import { createGatewayIdentityProvider } from '../auth/gatewayIdentity';
import type * as RefreshModule from '../auth/refresh';
import { resolveToken } from '../auth/resolveToken';
import { CLI_DISPLAY_NAME } from '../constants/identity';
import { removeStatus, spawnDaemon, stopDaemon, writeStatus } from '../daemon/manager';
import type * as DeviceRegister from '../device/register';
import { loadSettings, resolveCommandMode, saveSettings } from '../settings';
import { executeToolCall } from '../tools';
import { cleanupAllProcesses, probeSandbox } from '../tools/shell';
import { log, setVerbose } from '../utils/logger';
import { registerConnectCommand } from './connect';

const registerDeviceMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mintWorkspaceConnectTokenMock = vi.hoisted(() => vi.fn());
const registerWorkspaceDeviceMock = vi.hoisted(() => vi.fn());

vi.mock('../device/register', async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceRegister>();
  return {
    ...actual,
    mintWorkspaceConnectToken: mintWorkspaceConnectTokenMock,
    registerDevice: registerDeviceMock,
    registerWorkspaceDevice: registerWorkspaceDeviceMock,
  };
});

vi.mock('../auth/gatewayIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof GatewayIdentityModule>()),
  isGatewayIdentityRetryable: (error: Error) => error.message === 'GATEWAY_AUTHORITY_UNAVAILABLE',
  createGatewayIdentityProvider: vi.fn(() => async () => ({
    tenancyProtocol: 1,
    tenantId: 'tenant-A',
    userId: 'test-user',
    authorizationId: 'source-A',
    acceptedVersion: 7,
    principal: { kind: 'user', id: 'test-user' },
    capabilities: ['device:connect', 'device:respond'],
    gatewayTicket: 'dedicated-ticket',
    ticketExpiresAt: Date.now() + 300_000,
    authRecordExpiresAt: Date.now() + 300_000,
  })),
}));
vi.mock('../auth/refresh', async (importOriginal) => ({
  ...(await importOriginal<typeof RefreshModule>()),
  getValidToken: vi.fn().mockResolvedValue({
    credentials: { accessToken: 'test-token', expiresAt: undefined, refreshToken: 'test-refresh' },
    status: 'ok',
  }),
}));
vi.mock('../auth/resolveToken', () => ({
  resolveToken: vi.fn().mockResolvedValue({
    serverUrl: 'https://app.lobehub.com',
    token: 'test-token',
    tokenType: 'jwt',
    userId: 'test-user',
  }),
}));
vi.mock('../settings', () => ({
  addWorkspaceEnrollment: vi.fn(),
  loadOrCreateConnectionId: vi.fn().mockReturnValue('test-connection-id'),
  loadSettings: vi.fn().mockReturnValue(null),
  // Default: no persisted workspace shares, so runConnect skips the restore path.
  loadWorkspaceEnrollments: vi.fn().mockReturnValue([]),
  normalizeUrl: vi.fn((url?: string) => (url ? url.replace(/\/$/, '') : undefined)),
  removeWorkspaceEnrollment: vi.fn(),
  // Default: this device has no opinion on fencing, so connect's readiness
  // check is a no-op and every scenario below is unaffected by it.
  resolveCommandMode: vi.fn().mockReturnValue('auto'),
  resolveServerUrl: () => 'https://app.lobehub.com',
  resolveDeviceMetricsBacklogPath: vi.fn((id: string) => `/tmp/device-metrics/${id}.json`),
  saveSettings: vi.fn(),
}));

vi.mock('../auth/source', () => ({
  pickAuthSource: () => ({ kind: 'stored', token: 'test-token' }),
}));

vi.mock('../tools/shell', () => ({
  cleanupAllProcesses: vi.fn(),
  probeSandbox: vi.fn().mockResolvedValue({ available: true }),
}));

let mockRunningPid: number | null = null;
let mockSpawnedPid = 0;
let mockStatus: any = null;
vi.mock('../daemon/manager', () => ({
  appendLog: vi.fn(),
  getLogPath: vi.fn().mockReturnValue('/tmp/test-daemon.log'),
  getRunningDaemonPid: vi.fn().mockImplementation(() => mockRunningPid),
  readStatus: vi.fn().mockImplementation(() => mockStatus),
  removePid: vi.fn(),
  removeStatus: vi.fn(),
  reportDaemonStartupReady: vi.fn().mockResolvedValue(undefined),
  spawnDaemon: vi.fn().mockImplementation(() => {
    mockSpawnedPid = 99999;
    return mockSpawnedPid;
  }),
  stopDaemon: vi.fn().mockImplementation(() => {
    if (mockRunningPid !== null) {
      mockRunningPid = null;
      return true;
    }
    return false;
  }),
  writeStatus: vi.fn(),
}));

vi.mock('../tools', () => ({
  executeToolCall: vi.fn().mockResolvedValue({
    content: 'tool result',
    success: true,
  }),
}));

let clientEventHandlers: Record<string, (...args: any[]) => any> = {};
let clientOptions: any = {};
let connectCalled = false;
let lastSentToolResponse: any = null;
let lastSentSystemInfoResponse: any = null;
const clientReportMetrics = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const metricsSampler = vi.hoisted(() => ({
  flush: vi.fn().mockResolvedValue(undefined),
  options: undefined as any,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@lobechat/device-control', async (importOriginal) => ({
  ...(await importOriginal<typeof DeviceControlModule>()),
  DeviceMetricsSampler: vi.fn().mockImplementation(function (opts: any) {
    metricsSampler.options = opts;
    return metricsSampler;
  }),
}));

vi.mock('@lobechat/device-gateway-client', () => ({
  GatewayClient: vi.fn().mockImplementation(function (opts: any) {
    clientOptions = opts;
    clientEventHandlers = {};
    connectCalled = false;
    lastSentToolResponse = null;
    lastSentSystemInfoResponse = null;
    return {
      connect: vi.fn().mockImplementation(async () => {
        connectCalled = true;
      }),
      currentDeviceId: 'mock-device-id',
      disconnect: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: (...args: any[]) => any) => {
        clientEventHandlers[event] = handler;
      }),
      reconnect: vi.fn().mockResolvedValue(undefined),
      reportMetrics: clientReportMetrics,
      sendSystemInfoResponse: vi.fn().mockImplementation((data: any) => {
        lastSentSystemInfoResponse = data;
      }),
      sendToolCallResponse: vi.fn().mockImplementation((data: any) => {
        lastSentToolResponse = data;
      }),
      updateToken: vi.fn(),
    };
  }),
}));

describe('connect command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let signalListeners: Map<NodeJS.Signals, Set<(...args: unknown[]) => void>>;

  beforeEach(() => {
    signalListeners = new Map(
      (['SIGINT', 'SIGTERM'] as const).map((signal) => [
        signal,
        new Set(process.listeners(signal)),
      ]),
    );
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockRunningPid = null;
    mockSpawnedPid = 0;
    mockStatus = null;
  });

  afterEach(() => {
    for (const [signal, existing] of signalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!existing.has(listener)) process.removeListener(signal, listener);
      }
    }
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function createProgram() {
    const program = new Command();
    program.exitOverride();
    registerConnectCommand(program);
    return program;
  }

  it('should persist deviceId in status for foreground connections', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    expect(writeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connectionStatus: 'connecting', deviceId: 'mock-device-id' }),
    );

    clientEventHandlers.connected?.();

    expect(writeStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionStatus: 'connected', deviceId: 'mock-device-id' }),
    );
  });

  it('should persist deviceId in status for daemon child connections', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect', '--daemon-child']);

    expect(writeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connectionStatus: 'connecting', deviceId: 'mock-device-id' }),
    );

    clientEventHandlers.connected?.();

    expect(writeStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionStatus: 'connected', deviceId: 'mock-device-id' }),
    );
  });

  it('records the request on arrival and retains its timestamp across connection updates', async () => {
    const pending = Promise.withResolvers<{ content: string; success: boolean }>();
    vi.mocked(executeToolCall).mockImplementationOnce(() => pending.promise);
    await createProgram().parseAsync(['node', 'test', 'connect', '--daemon-child']);

    const running = clientEventHandlers.tool_call_request?.({
      attemptId: 'attempt-1',
      executionSignal: new AbortController().signal,
      isExecutionCurrent: () => true,
      requestId: 'req-1',
      toolCall: { apiName: 'readLocalFile', arguments: '{}', identifier: 'test' },
      type: 'tool_call_request',
    });
    const received = vi.mocked(writeStatus).mock.lastCall?.[0];
    expect(received).toEqual(
      expect.objectContaining({ deviceId: 'mock-device-id', lastRequestAt: expect.any(String) }),
    );
    clientEventHandlers.connected?.();
    expect(vi.mocked(writeStatus).mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        connectionStatus: 'connected',
        lastRequestAt: received?.lastRequestAt,
      }),
    );
    pending.resolve({ content: 'ok', success: true });
    await running;
  });

  it('should connect to gateway', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    expect(connectCalled).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(CLI_DISPLAY_NAME));
  });

  it('should require explicit gateway for custom login server', async () => {
    vi.mocked(loadSettings).mockReturnValueOnce({ serverUrl: 'https://self-hosted.example.com' });

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'connect'])).rejects.toThrow('process.exit');
    expect(log.error).toHaveBeenCalledWith(
      "Current login uses custom --server https://self-hosted.example.com. Please also provide '--gateway <url>' for the device gateway.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  /**
   * A device configured to fence everything, on a host that cannot, would
   * otherwise connect successfully and then refuse every command it is sent —
   * online and healthy from the server's side, with the reason buried in
   * per-command errors.
   */
  it('refuses to connect when it must sandbox but cannot', async () => {
    vi.mocked(resolveCommandMode).mockReturnValueOnce('sandbox');
    vi.mocked(probeSandbox).mockResolvedValueOnce({
      available: false,
      reason: 'unsupported host',
    } as never);

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'connect'])).rejects.toThrow('process.exit');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('unsupported host'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('connects normally when it must sandbox and can', async () => {
    vi.mocked(resolveCommandMode).mockReturnValueOnce('sandbox');
    vi.mocked(probeSandbox).mockResolvedValueOnce({ available: true } as never);

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should use explicit gateway for custom login server', async () => {
    vi.mocked(loadSettings).mockReturnValueOnce({ serverUrl: 'https://self-hosted.example.com' });

    const program = createProgram();
    await program.parseAsync([
      'node',
      'test',
      'connect',
      '--gateway',
      'https://gateway.example.com/',
    ]);

    expect(clientOptions.gatewayUrl).toBe('https://gateway.example.com');
    expect(saveSettings).toHaveBeenCalledWith({
      gatewayUrl: 'https://gateway.example.com',
      serverUrl: 'https://self-hosted.example.com',
    });
  });
  it('should pass the resolved serverUrl to GatewayClient', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    expect(clientOptions.serverUrl).toBe('https://app.lobehub.com');
  });

  it('should handle tool call requests', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    // Trigger tool call
    await clientEventHandlers['tool_call_request']?.({
      attemptId: 'attempt-1',
      executionSignal: new AbortController().signal,
      isExecutionCurrent: () => true,
      requestId: 'req-1',
      toolCall: { apiName: 'readLocalFile', arguments: '{"path":"/test"}', identifier: 'test' },
      type: 'tool_call_request',
    });

    // The connected device's credentials ride along so `readFile` can upload images.
    expect(executeToolCall).toHaveBeenCalledWith(
      'readLocalFile',
      '{"path":"/test"}',
      undefined,
      expect.objectContaining({ token: 'test-token' }),
      expect.any(AbortSignal),
    );
    expect(lastSentToolResponse).toEqual({
      attemptId: 'attempt-1',
      requestId: 'req-1',
      result: {
        content: 'tool result',
        error: undefined,
        // Timed on this machine's clock, so the value is whatever the mock took
        // — what matters is that the device reports one at all: the server can
        // only observe the round trip, and cannot otherwise tell a slow tool
        // from slow transport.
        executionTimeMs: expect.any(Number),
        state: undefined,
        success: true,
      },
    });
    expect(lastSentToolResponse.result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle system info requests', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    await clientEventHandlers['system_info_request']?.({
      attemptId: 'attempt-2',
      executionSignal: new AbortController().signal,
      isExecutionCurrent: () => true,
      requestId: 'req-2',
      type: 'system_info_request',
    });

    expect(lastSentSystemInfoResponse).toBeDefined();
    expect(lastSentSystemInfoResponse.requestId).toBe('req-2');
    expect(lastSentSystemInfoResponse.result.success).toBe(true);
    expect(lastSentSystemInfoResponse.result.systemInfo).toHaveProperty('homePath');
    expect(lastSentSystemInfoResponse.result.systemInfo).toHaveProperty('arch');
    expect(lastSentSystemInfoResponse.result.systemInfo.defaultShell).toEqual(expect.any(String));
  });

  it('should handle auth_failed', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    await clientEventHandlers['auth_failed']?.('invalid token');

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('authentication stopped'));
    expect(cleanupAllProcesses).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('stops when another connect process takes over the connection', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    clientEventHandlers['replaced']?.();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('took over'));
    expect(cleanupAllProcesses).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('renews expiration on the existing provider without resolving another credential', async () => {
    await createProgram().parseAsync(['node', 'test', 'connect']);
    const client = vi.mocked(GatewayClient).mock.results.at(-1)!.value;
    await clientEventHandlers.auth_expired();
    expect(client.reconnect).toHaveBeenCalledOnce();
    expect(resolveToken).toHaveBeenCalledOnce();
  });

  it('explains the workspace administrator requirement and treats refusal as permanent', async () => {
    vi.mocked(createGatewayIdentityProvider).mockReturnValueOnce(async () => {
      throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', status: 403 });
    });
    await createProgram().parseAsync(['node', 'test', 'connect', '--workspace', 'workspace']);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('workspace administrator'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(GatewayClient).not.toHaveBeenCalled();
  });

  it('reports identity refusal before connecting and exits with failure', async () => {
    vi.mocked(createGatewayIdentityProvider).mockReturnValueOnce(async () => {
      throw new Error('SOURCE_UNVERIFIABLE');
    });
    await createProgram().parseAsync(['node', 'test', 'connect']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(GatewayClient).not.toHaveBeenCalled();
  });

  it('should handle error event', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    clientEventHandlers['error']?.(new Error('connection lost'));

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });

  it('should set verbose mode when -v flag is passed', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect', '-v']);

    expect(setVerbose).toHaveBeenCalledWith(true);
  });

  it('should handle SIGINT', async () => {
    const sigintHandlers: Array<() => Promise<void> | void> = [];
    const origOn = process.on;
    vi.spyOn(process, 'on').mockImplementation((event: any, handler: any) => {
      if (event === 'SIGINT') sigintHandlers.push(handler);
      return origOn.call(process, event, handler);
    });

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    // Trigger SIGINT handler
    for (const handler of sigintHandlers) {
      await handler();
    }

    expect(cleanupAllProcesses).toHaveBeenCalled();
    expect(removeStatus).toHaveBeenCalled();
  });

  it('should handle SIGTERM', async () => {
    const sigtermHandlers: Array<() => Promise<void> | void> = [];
    const origOn = process.on;
    vi.spyOn(process, 'on').mockImplementation((event: any, handler: any) => {
      if (event === 'SIGTERM') sigtermHandlers.push(handler);
      return origOn.call(process, event, handler);
    });

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    for (const handler of sigtermHandlers) {
      await handler();
    }

    expect(cleanupAllProcesses).toHaveBeenCalled();
  });

  it('should generate correct system info with Movies for non-linux', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'test', 'connect']);

    await clientEventHandlers['system_info_request']?.({
      attemptId: 'attempt-3',
      executionSignal: new AbortController().signal,
      isExecutionCurrent: () => true,
      requestId: 'req-3',
      type: 'system_info_request',
    });

    const sysInfo = lastSentSystemInfoResponse.result.systemInfo;
    // On macOS (darwin), video dir should be Movies
    if (process.platform !== 'linux') {
      expect(sysInfo.videosPath).toContain('Movies');
    } else {
      expect(sysInfo.videosPath).toContain('Videos');
    }
  });

  describe('--daemon flag', () => {
    it('should spawn daemon and exit', async () => {
      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', '--daemon']);

      expect(spawnDaemon).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Daemon started'));
    });

    it('should refuse if daemon already running', async () => {
      mockRunningPid = 12345;

      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', '--daemon']);

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('already running'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('connect stop', () => {
    it('should stop running daemon', async () => {
      mockRunningPid = 12345;

      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', 'stop']);

      expect(stopDaemon).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Daemon stopped'));
    });

    it('should warn if no daemon is running', async () => {
      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', 'stop']);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No daemon'));
    });
  });

  describe('disconnect (alias for connect stop)', () => {
    it('should stop running daemon', async () => {
      mockRunningPid = 12345;

      const program = createProgram();
      await program.parseAsync(['node', 'test', 'disconnect']);

      expect(stopDaemon).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Daemon stopped'));
    });

    it('should warn if no daemon is running', async () => {
      const program = createProgram();
      await program.parseAsync(['node', 'test', 'disconnect']);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No daemon'));
    });
  });

  describe('connect status', () => {
    it('should show no daemon running', async () => {
      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', 'status']);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No daemon'));
    });

    it('should show daemon status', async () => {
      mockRunningPid = 12345;
      mockStatus = {
        connectionStatus: 'connected',
        gatewayUrl: 'https://gateway.test.com',
        pid: 12345,
        startedAt: new Date(Date.now() - 3600_000).toISOString(),
      };

      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', 'status']);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Daemon Status'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('12345'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('connected'));
    });
  });

  describe('connect restart', () => {
    it('should stop and start daemon', async () => {
      mockRunningPid = 12345;

      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', 'restart']);

      expect(stopDaemon).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Stopped existing'));
      expect(spawnDaemon).toHaveBeenCalled();
    });

    it('should start daemon even if none was running', async () => {
      const program = createProgram();
      await program.parseAsync(['node', 'test', 'connect', 'restart']);

      expect(spawnDaemon).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Daemon started'));
    });
  });
});
