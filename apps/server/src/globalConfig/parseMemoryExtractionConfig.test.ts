import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMemoryExtractionConfig } from './parseMemoryExtractionConfig';

const WORKFLOW_PARALLELISM_ENV = 'MEMORY_USER_MEMORY_WORKFLOW_PROCESS_USER_TOPICS_PARALLELISM';

const originalWorkflowParallelism = process.env[WORKFLOW_PARALLELISM_ENV];

describe('parseMemoryExtractionConfig', () => {
  afterEach(() => {
    if (originalWorkflowParallelism === undefined) {
      delete process.env[WORKFLOW_PARALLELISM_ENV];
      return;
    }

    process.env[WORKFLOW_PARALLELISM_ENV] = originalWorkflowParallelism;
  });

  it('defaults process-user-topics workflow parallelism to 25', () => {
    delete process.env[WORKFLOW_PARALLELISM_ENV];

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(25);
  });

  it('parses process-user-topics workflow parallelism from env', () => {
    process.env[WORKFLOW_PARALLELISM_ENV] = '17';

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(17);
  });

  it('falls back to 25 when process-user-topics workflow parallelism env is invalid', () => {
    process.env[WORKFLOW_PARALLELISM_ENV] = '0';

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(25);

    process.env[WORKFLOW_PARALLELISM_ENV] = 'abc';

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(25);
  });
});

describe('parseMemoryExtractionConfig model selection env', () => {
  const loadConfig = async (enableBusinessFeatures: boolean) => {
    vi.resetModules();
    vi.doMock('@lobechat/business-const', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      ENABLE_BUSINESS_FEATURES: enableBusinessFeatures,
    }));
    const { parseMemoryExtractionConfig: parse } = await import('./parseMemoryExtractionConfig');

    return parse();
  };

  beforeEach(() => {
    for (const agent of ['GATEKEEPER', 'LAYER_EXTRACTOR', 'EMBEDDING', 'PERSONA_WRITER']) {
      vi.stubEnv(`MEMORY_USER_MEMORY_${agent}_API_KEY`, `${agent}-key`);
      vi.stubEnv(`MEMORY_USER_MEMORY_${agent}_BASE_URL`, `https://${agent}.example.com`);
      vi.stubEnv(`MEMORY_USER_MEMORY_${agent}_MODEL`, `${agent}-model`);
      vi.stubEnv(`MEMORY_USER_MEMORY_${agent}_PROVIDER`, `${agent}-provider`);
    }
    vi.stubEnv('MEMORY_USER_MEMORY_LAYER_EXTRACTOR_IDENTITY_MODEL', 'identity-model');
    vi.stubEnv('MEMORY_USER_MEMORY_EMBEDDING_CONTEXT_LIMIT', '4000');
    vi.stubEnv('MEMORY_USER_MEMORY_CONCURRENCY', '3');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@lobechat/business-const');
  });

  it('ignores agent models and credentials from env in business builds', async () => {
    const config = await loadConfig(true);

    for (const agent of [
      config.agentGateKeeper,
      config.agentLayerExtractor,
      config.agentPersonaWriter,
      config.embedding,
    ]) {
      expect(agent.apiKey).toBeUndefined();
      expect(agent.baseURL).toBeUndefined();
      expect(agent.model).not.toMatch(/-model$/);
      expect(agent.provider).not.toMatch(/-provider$/);
    }
    expect(config.agentLayerExtractor.layers.identity).toBe(config.agentLayerExtractor.model);

    // Operational tuning stays per instance.
    expect(config.embedding.contextLimit).toBe(4000);
    expect(config.concurrency).toBe(3);
  });

  it('reads agent models and credentials from env in other builds', async () => {
    const config = await loadConfig(false);

    expect(config.agentGateKeeper).toMatchObject({
      apiKey: 'GATEKEEPER-key',
      baseURL: 'https://GATEKEEPER.example.com',
      model: 'GATEKEEPER-model',
      provider: 'GATEKEEPER-provider',
    });
    expect(config.embedding).toMatchObject({
      apiKey: 'EMBEDDING-key',
      model: 'EMBEDDING-model',
    });
    expect(config.agentLayerExtractor.layers.identity).toBe('identity-model');
  });
});
