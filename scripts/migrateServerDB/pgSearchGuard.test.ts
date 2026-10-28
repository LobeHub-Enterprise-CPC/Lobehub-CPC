// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { getFtsSearchConfig } from '../../packages/env/src/ftsSearch';
import { PG_SEARCH_BM25_INDEXES } from '../pgSearchCleanup/inventory';
import {
  assertPgSearchReady,
  DEFAULT_FTS_SEARCH_PROVIDER,
  PG_SEARCH_BM25_INDEX_NAMES,
  PgSearchNotReadyError,
} from './pgSearchGuard';

type Rows = { rows: Record<string, unknown>[] };

/** Answer the extension and index catalog queries with a fixed database state. */
const fakeCatalog =
  (state: { extension: boolean; indexes: readonly string[] }) =>
  async (text: string): Promise<Rows> =>
    text.includes('pg_extension')
      ? { rows: state.extension ? [{ '?column?': 1 }] : [] }
      : { rows: state.indexes.map((index_name) => ({ index_name })) };

describe('pgSearchGuard', () => {
  it.each(['pg_like', 'elasticsearch'])('does not query readiness for %s', async (provider) => {
    const query = vi.fn();
    await expect(
      assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: provider }),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates catalog failures instead of accepting readiness', async () => {
    const error = new Error('catalog unavailable');
    await expect(
      assertPgSearchReady(
        async () => {
          throw error;
        },
        { FTS_SEARCH_PROVIDER: 'pg_search' },
      ),
    ).rejects.toBe(error);
  });
  it('uses the same default provider as the application env', () => {
    vi.stubEnv('FTS_SEARCH_PROVIDER', undefined);
    expect(getFtsSearchConfig().FTS_SEARCH_PROVIDER).toBe(DEFAULT_FTS_SEARCH_PROVIDER);
    vi.unstubAllEnvs();
  });

  it('checks the same BM25 indexes that pg_search cleanup manages', () => {
    expect([...PG_SEARCH_BM25_INDEX_NAMES].sort()).toEqual(
      PG_SEARCH_BM25_INDEXES.map(({ name }) => name).sort(),
    );
  });

  it('passes a pg_search database with every BM25 index', async () => {
    const query = fakeCatalog({ extension: true, indexes: PG_SEARCH_BM25_INDEX_NAMES });
    await expect(
      assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: 'pg_search' }),
    ).resolves.toBeUndefined();
  });

  it('requires pg_search readiness when the provider is unset', async () => {
    const query = fakeCatalog({ extension: false, indexes: [] });
    await expect(assertPgSearchReady(query, {})).rejects.toBeInstanceOf(PgSearchNotReadyError);
  });

  it('names the missing BM25 indexes when the extension was installed afterwards', async () => {
    const query = fakeCatalog({
      extension: true,
      indexes: PG_SEARCH_BM25_INDEX_NAMES.filter((name) => name !== 'messages_bm25_idx'),
    });

    const error = await assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: 'pg_search' }).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(PgSearchNotReadyError);
    expect((error as Error).message).toContain('missing 1 of its BM25 indexes (messages_bm25_idx)');
    expect((error as Error).message).toContain('0093_add_bm25_indexes_with_icu.sql');
  });
});
