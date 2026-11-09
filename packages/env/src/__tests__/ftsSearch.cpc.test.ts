// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const loadFtsSearchEnv = async () => (await import('../ftsSearch')).ftsSearchEnv;

describe('CPC ftsSearchEnv', () => {
  it('searches on Elasticsearch when no provider is configured', async () => {
    vi.stubEnv('FTS_SEARCH_PROVIDER', undefined);

    expect((await loadFtsSearchEnv()).FTS_SEARCH_PROVIDER).toBe('elasticsearch');
  });

  it('keeps an explicitly configured provider', async () => {
    vi.stubEnv('FTS_SEARCH_PROVIDER', 'pg_like');

    expect((await loadFtsSearchEnv()).FTS_SEARCH_PROVIDER).toBe('pg_like');
  });
});
