/**
 * @vitest-environment node
 */
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import type * as SsrfSafeFetch from '@lobechat/ssrf-safe-fetch';
import type * as ModelBankModule from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';
import { getTenantLiveResources } from '@/server/modules/Tenant/liveResources';
import { TenantRuntime } from '@/server/modules/Tenant/runtime';

import { AgentRuntimeService } from './AgentRuntimeService';
import { hookDispatcher } from './hooks';
import type { AgentExecutionParams } from './types';

vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));

// Callbacks are addressed to the test tenant `acme` (see __mocks__/callbackUrl).
vi.mock('@/server/modules/Tenant/callbackUrl');

vi.mock('@lobechat/model-runtime', () => ({
  // RuntimeExecutors (loaded transitively) resolves extend params via this
  // helper; an empty result keeps the runtime payload unchanged.
  applyModelExtendParams: vi.fn(function () {
    return {};
  }),
  getModelPropertyWithFallback: vi.fn(),
  // `llmErrorClassification.ts` reads these at module-load time; an empty
  // spec map is fine here because this suite never exercises the runtime
  // retry classifier path.
  ERROR_CODE_SPECS: {},
  getErrorCodeSpec: () => undefined,
  refineErrorCode: () => undefined,
}));

const { ssrfSafeFetch: mockSsrfSafeFetch } = vi.hoisted(() => ({ ssrfSafeFetch: vi.fn() }));
vi.mock('@lobechat/ssrf-safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof SsrfSafeFetch>()),
  ssrfSafeFetch: mockSsrfSafeFetch,
}));

// Mock trusted client to avoid server-side env access
vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn().mockReturnValue(undefined),
  getTrustedClientTokenForSession: vi.fn().mockResolvedValue(undefined),
  isTrustedClientEnabled: vi.fn().mockReturnValue(false),
}));

// Mock database and models
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(function () {
    return {
      getFullFileUrl: vi.fn(async (path: string) => `model:${path}`),
      getFileAccessUrl: vi.fn(async (file: { id: string }) => `ui:${file.id}`),
    };
  }),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(function () {
    return {
      findById: vi.fn().mockResolvedValue(undefined),
      findMessagePlugin: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn().mockImplementation(function () {
    return {
      getAgentConfigById: vi.fn(),
    };
  }),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(function () {
    return {
      query: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Mock ModelRuntime to avoid server-side env access
vi.mock('@/server/modules/ModelRuntime', () => ({
  initializeRuntimeOptions: vi.fn(),
  ApiKeyManager: vi.fn().mockImplementation(function () {
    return {
      getApiKey: vi.fn(),
      getAllApiKeys: vi.fn(),
    };
  }),
}));

// Mock search service to avoid server-side env access
vi.mock('@/server/services/search', () => ({
  SearchService: vi.fn().mockImplementation(function () {
    return {
      search: vi.fn(),
    };
  }),
  searchService: {
    search: vi.fn(),
  },
}));

// Mock factory and redis dependencies to break env import chains,
// so the barrel can be imported with real AgentRuntimeCoordinator + InMemory backends
vi.mock('@/server/modules/AgentRuntime/factory', async () => {
  const { InMemoryAgentStateManager } =
    await import('@/server/modules/AgentRuntime/InMemoryAgentStateManager');
  const { InMemoryStreamEventManager } =
    await import('@/server/modules/AgentRuntime/InMemoryStreamEventManager');
  return {
    createAgentStateManager: () => new InMemoryAgentStateManager(),
    createStreamEventManager: () => new InMemoryStreamEventManager(),
    isRedisAvailable: () => false,
  };
});

vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  createAgentRuntimeRedisClient: vi.fn().mockReturnValue(null),
  getAgentRuntimeRedisClient: vi.fn().mockReturnValue(null),
}));

// Use real AgentRuntimeCoordinator with InMemory backends; only mock unrelated exports
vi.mock('@/server/modules/AgentRuntime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRuntimeExecutors: vi.fn(),
  };
});

// Spread the real module and override only `AgentRuntime` (to stub `.step()`).
// Keeps the real status predicates + package-hosted executors (e.g. `finish`),
// so this mock survives future executor migrations without edits.
vi.mock('@lobechat/agent-runtime', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  AgentRuntime: vi.fn().mockImplementation(function (_agent, _options) {
    return {
      step: vi.fn(),
    };
  }),
}));

vi.mock('@/server/services/queue', () => ({
  QueueService: vi.fn().mockImplementation(function () {
    return {
      getImpl: vi.fn().mockReturnValue(null),
      scheduleMessage: vi.fn(),
    };
  }),
}));

// Mock Mecha module
vi.mock('@/server/modules/Mecha', () => ({
  createServerAgentToolsEngine: vi.fn().mockReturnValue({
    generateToolsDetailed: vi.fn().mockReturnValue({
      tools: [],
      enabledToolIds: [],
      filteredTools: [],
    }),
    getEnabledPluginManifests: vi.fn().mockReturnValue(new Map()),
  }),
  serverMessagesEngine: vi.fn().mockResolvedValue([]),
}));

// Mock model-bank
vi.mock('model-bank', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelBankModule>();
  return {
    ...actual,
    LOBE_DEFAULT_MODEL_LIST: [
      {
        id: 'gpt-4o-mini',
        providerId: 'openai',
        abilities: {
          functionCall: true,
          vision: true,
          video: false,
        },
      },
    ],
  };
});

describe('AgentRuntimeService tenant suspension', () => {
  let service: AgentRuntimeService;
  let mockCoordinator: any;
  let mockStreamManager: any;
  let mockDb: any;
  const mockUserId = 'test-user-id';
  const mockParams: AgentExecutionParams = {
    operationId: 'test-operation-1',
    stepIndex: 1,
    context: {
      phase: 'user_input',
      payload: {
        message: { content: 'test' },
        sessionId: 'test-operation-1',
        isFirstMessage: false,
      },
      session: {
        sessionId: 'test-operation-1',
        status: 'running',
        stepCount: 1,
        messageCount: 1,
      },
    },
  };

  const mockState = {
    operationId: 'test-operation-1',
    status: 'running',
    stepCount: 1,
    messages: [],
    events: [],
    lastModified: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_RUNTIME_BASE_URL = 'http://localhost:3010';

    // Mock database
    mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    service = new AgentRuntimeService(mockDb, mockUserId);

    // Get real instances (backed by InMemory implementations)
    mockCoordinator = (service as any).coordinator;
    mockStreamManager = (service as any).streamManager;

    // Auto-spy all coordinator methods so tests can use .mockResolvedValue() / .toHaveBeenCalledWith()
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(mockCoordinator))) {
      if (key !== 'constructor' && typeof mockCoordinator[key] === 'function') {
        vi.spyOn(mockCoordinator, key);
      }
    }
    // Auto-spy all streamManager methods
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(mockStreamManager))) {
      if (key !== 'constructor' && typeof mockStreamManager[key] === 'function') {
        vi.spyOn(mockStreamManager, key);
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.AGENT_RUNTIME_BASE_URL;
    hookDispatcher.unregister('test-operation-1');
  });

  it('should cancel an in-flight step like a Stop when its tenant is suspended', async () => {
    const mockStepResult = {
      events: [],
      newState: { ...mockState, status: 'running', stepCount: 2 },
      nextContext: mockParams.context,
    };
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => (stepStarted = resolve));
    let stepSignal: AbortSignal | undefined;
    vi.spyOn(service as any, 'createAgentRuntime').mockImplementation(function (
      ...args: unknown[]
    ) {
      const { abortSignal } = args[0] as { abortSignal: AbortSignal };
      stepSignal = abortSignal;
      return {
        runtime: {
          step: vi.fn(function () {
            stepStarted();
            // A long LLM / tool call that only ends when aborted.
            return new Promise((resolve) => {
              abortSignal.addEventListener('abort', () => resolve(mockStepResult), {
                once: true,
              });
            });
          }),
        },
      };
    });
    const executionContext = { tenantId: 't-step', sourceAcceptedVersion: 1 };
    mockCoordinator.loadAgentState.mockResolvedValue({
      ...mockState,
      execution: executionContext,
    });
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ metadata: executionContext }] }) }),
    });
    const admission = vi.spyOn(TenantRuntime.prototype, 'gatewayAdmission').mockResolvedValue({
      tenantId: 't-step',
      acceptedVersion: 1,
      effectiveState: 'active',
      checkedAt: Date.now(),
      leaseExpiresAt: Date.now() + 30_000,
    });
    let interrupted = false;
    mockCoordinator.isInterrupted.mockImplementation(async () => interrupted);
    mockCoordinator.markInterrupted.mockImplementation(async () => {
      interrupted = true;
    });
    const scope = {
      acceptedVersion: 1,
      session: { database: mockDb },
      slug: 'acme',
      tenantId: 't-step',
    } as unknown as TenantScope;
    const execution = runWithTenantScope(scope, () => service.executeStep(mockParams));
    await started;
    expect(getTenantLiveResources().size('t-step')).toBeGreaterThan(0);
    await getTenantLiveResources().suspend('t-step', new TenantGateError('TENANT_FROZEN'));
    const result = await execution;
    expect(stepSignal?.aborted).toBe(true);
    expect(mockCoordinator.markInterrupted).toHaveBeenCalledWith('test-operation-1');
    expect(result.state).toEqual(expect.objectContaining({ status: 'interrupted' }));
    expect(result.nextStepScheduled).toBe(false);
    admission.mockRestore();
    expect(getTenantLiveResources().size('t-step')).toBe(0);
  });
});
