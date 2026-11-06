// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FtsSearchMigrationLockClient, FtsSearchMigrationLockError } from '../migrationLock';
import { jsonResponse, StatefulElasticsearch } from './migrationLock.testUtils';

const createClient = (namespace: string, owner?: string) =>
  new FtsSearchMigrationLockClient({
    allowInsecureHttp: true,
    namespace,
    owner,
    url: 'http://localhost:9200',
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FtsSearchMigrationLockClient', () => {
  it('uses an explicitly supplied bootstrap v4 owner and otherwise generates an unmarked UUID', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const owner = 'bootstrap:00000000-0000-4000-8000-000000000001';
    expect((await createClient('bootstrap', owner).acquire('apply')).owner).toBe(owner);
    expect((await createClient('manual').acquire('apply')).owner).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });

  it('retains the lock when the namespace also appears outside a recognized indices group', async () => {
    const elasticsearch = new StatefulElasticsearch();
    elasticsearch.tasks = {
      nodes: {
        node: {
          tasks: {
            'node:1': {
              action: 'indices:data/write/reindex',
              description: 'indices[other-agents-v1], source[test-agents-v1]',
            },
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    await expect(createClient('test').assertNoNamespaceTasks()).rejects.toThrow('in-flight');
  });

  it.each([
    '',
    'manual-owner',
    'bootstrap:00000000-0000-1000-8000-000000000001',
    'bootstrap:00000000-0000-4000-7000-000000000001',
    'BOOTSTRAP:00000000-0000-4000-8000-000000000001',
    'bootstrap:00000000-0000-4000-8000-000000000001\n',
  ])('rejects invalid bootstrap owner %j before making a request', async (owner) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(async () => createClient('test', owner).acquire('apply')).rejects.toThrow(
      'bootstrap',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('only permits recovery when the detailed task list excludes namespace writes and admin work', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    await expect(createClient('test').assertNoNamespaceTasks()).resolves.toBeUndefined();
    expect(elasticsearch.requests[0].pathname).toContain('detailed=true');
    const tasksUrl = new URL(elasticsearch.requests[0].pathname, 'http://localhost');
    expect(tasksUrl.searchParams.get('actions')).toBe('indices:data/write/*,indices:admin/*');
    elasticsearch.tasks = {
      nodes: {
        node: {
          tasks: {
            'node:1': {
              action: 'indices:data/write/bulk',
              description: 'requests[1], indices[other-agents-v1]',
            },
          },
        },
      },
    };
    await expect(createClient('test').assertNoNamespaceTasks()).resolves.toBeUndefined();
    elasticsearch.tasks = {
      nodes: {
        node: {
          tasks: {
            'node:1': {
              action: 'indices:admin/create',
              description: 'create-index [test-agents-v1], cause [api]',
            },
          },
        },
      },
    };
    await expect(createClient('test').assertNoNamespaceTasks()).rejects.toThrow('in-flight');
  });

  it.each([
    {},
    { nodes: {}, node_failures: [{}] },
    { nodes: {}, task_failures: [{}] },
    { nodes: {}, timed_out: true },
    { nodes: { node: { tasks: { 'node:1': { action: 'indices:data/write/bulk' } } } } },
    {
      nodes: {
        node: {
          tasks: {
            'node:1': { action: 'indices:data/write/bulk', description: 'requests[1], indices[*]' },
          },
        },
      },
    },
  ])(
    'keeps recovery blocked for incomplete, failed or ambiguous task observations (%j)',
    async (tasks) => {
      const elasticsearch = new StatefulElasticsearch();
      elasticsearch.tasks = tasks;
      vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
      await expect(createClient('test').assertNoNamespaceTasks()).rejects.toThrow();
    },
  );

  it('allows only one owner across clients that use the same namespace', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const first = createClient('shared');
    const second = createClient('shared');

    const results = await Promise.allSettled([
      first.acquire('--apply --checkpoint-dir=/first'),
      second.acquire('--apply --checkpoint-dir=/second'),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringContaining('already locked by owner'),
        status: 409,
      }),
    });
  });

  it('isolates locks by namespace', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    const [first, second] = await Promise.all([
      createClient('preview-a').acquire('--apply'),
      createClient('preview-b').acquire('--apply'),
    ]);

    expect(first.owner).not.toBe(second.owner);
    expect(elasticsearch.indexes.has('preview-a-fts-search-control')).toBe(true);
    expect(elasticsearch.indexes.has('preview-b-fts-search-control')).toBe(true);
  });

  it('creates a strict owned control index without unsupported serverless settings', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');

    const result = await client.withLock('--status', async (handle) => {
      await client.assertOwner(handle);
      return 'done';
    });

    expect(result).toBe('done');
    expect(await client.read()).toBeNull();
    const createRequest = elasticsearch.requests.find(
      ({ method, pathname }) => method === 'PUT' && pathname === '/test-fts-search-control',
    );
    expect(JSON.parse(createRequest?.body ?? '{}')).toEqual({
      mappings: {
        _meta: { lobehub_fts_search_control: true, schema_version: 1 },
        dynamic: 'strict',
        properties: {
          acquiredAt: { type: 'date' },
          command: { type: 'keyword' },
          owner: { type: 'keyword' },
        },
      },
    });
  });

  it('does not misclassify an invalid create request as an existing index', async () => {
    const elasticsearch = new StatefulElasticsearch();
    elasticsearch.createFailure = {
      body: { error: { type: 'illegal_argument_exception' } },
      status: 400,
    };
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    await expect(createClient('test').acquire('--apply')).rejects.toMatchObject({
      message: 'Elasticsearch migration control index creation failed (400)',
      status: 400,
    });
    expect(elasticsearch.requests).toEqual([
      { body: expect.any(String), method: 'PUT', pathname: '/test-fts-search-control' },
    ]);
  });

  it('retains the lock when the callback fails and supports explicit recovery', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');
    const failure = new Error('request timed out');

    const error = await client
      .withLock('--promote', async () => {
        throw failure;
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(FtsSearchMigrationLockError);
    if (!(error instanceof FtsSearchMigrationLockError)) throw error;
    expect(error).toMatchObject({ cause: failure, recoveryOwner: expect.any(String) });
    expect(error.message).toContain('non-expiring lock was retained');
    const current = await client.read();
    expect(current?.owner).toBe(error.recoveryOwner);
    if (!error.recoveryOwner) throw new Error('Expected a recovery owner');
    expect(await client.release(error.recoveryOwner)).toBe('released');
  });

  it('does not take over a residual lock', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const first = createClient('test');
    const residual = await first.acquire('--apply');

    await expect(createClient('test').acquire('--retire')).rejects.toThrow(
      `already locked by owner ${residual.owner}`,
    );
    expect((await first.read())?.owner).toBe(residual.owner);
  });

  it('rejects a wrong owner and uses sequence-number CAS for release', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');
    const handle = await client.acquire('--apply');

    await expect(client.release('wrong-owner')).rejects.toThrow('refusing release for owner');

    elasticsearch.beforeNextDelete = () => {
      const document = elasticsearch.indexes.get(client.controlIndex)?.document;
      if (document) document.seqNo += 1;
    };
    await expect(client.release(handle.owner)).rejects.toMatchObject({ status: 409 });
    expect((await client.read())?.owner).toBe(handle.owner);
  });

  it('detects a stale ownership handle', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');
    const handle = await client.acquire('--apply');
    const document = elasticsearch.indexes.get(client.controlIndex)?.document;
    if (document) document.seqNo += 1;

    await expect(client.assertOwner(handle)).rejects.toThrow('ownership was lost');
  });

  it('returns already_released when the lock is absent', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    await expect(createClient('test').release('known-owner')).resolves.toBe('already_released');
  });

  it('fails closed for a malformed successful release response', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');
    const handle = await client.acquire('--apply');
    elasticsearch.lockDeleteBody = { result: 'noop' };

    await expect(client.release(handle.owner)).rejects.toThrow('invalid shape');
  });

  it('reads missing status without creating anything', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');

    await expect(client.read()).resolves.toBeNull();
    expect(elasticsearch.requests).toEqual([
      { method: 'GET', pathname: '/test-fts-search-control/_doc/migration-lock' },
    ]);
    expect(elasticsearch.indexes).toHaveLength(0);
  });

  it.each(['', '_all', '-preview', '+preview', 'Preview', 'preview/current', 'preview,*'])(
    'rejects an unsafe namespace %j without making a request',
    (namespace) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      expect(() => createClient(namespace)).toThrow('one legal lowercase Elasticsearch index name');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects control index names longer than 255 UTF-8 bytes without making a request', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(() => createClient('界'.repeat(80))).toThrow(
      'one legal lowercase Elasticsearch index name',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed for forbidden and malformed status responses', async () => {
    const elasticsearch = new StatefulElasticsearch();
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));
    const client = createClient('test');

    elasticsearch.lockReadStatus = 403;
    await expect(client.read()).rejects.toMatchObject({ status: 403 });

    elasticsearch.lockReadStatus = undefined;
    elasticsearch.lockReadBody = { found: false };
    await expect(client.read()).rejects.toThrow('invalid shape');
  });

  it('refuses an existing foreign or incompatible control index', async () => {
    const elasticsearch = new StatefulElasticsearch();
    elasticsearch.indexes.set('test-fts-search-control', {
      mappings: { dynamic: 'strict', properties: { owner: { type: 'keyword' } } },
    });
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    await expect(createClient('test').acquire('--apply')).rejects.toThrow(
      'refusing to overwrite it',
    );
    expect(elasticsearch.indexes.get('test-fts-search-control')?.document).toBeUndefined();
  });

  it('refuses to release a matching lock document from a foreign control index', async () => {
    const elasticsearch = new StatefulElasticsearch();
    elasticsearch.indexes.set('test-fts-search-control', {
      document: {
        primaryTerm: 1,
        seqNo: 0,
        source: {
          acquiredAt: '2026-09-08T00:00:00.000Z',
          command: '--apply',
          owner: 'matching-owner',
        },
      },
      mappings: {
        dynamic: 'strict',
        properties: {
          acquiredAt: { type: 'date' },
          command: { type: 'keyword' },
          owner: { type: 'keyword' },
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    await expect(createClient('test').release('matching-owner')).rejects.toThrow(
      'refusing to overwrite it',
    );
    expect(elasticsearch.indexes.get('test-fts-search-control')?.document).toBeDefined();
    expect(elasticsearch.requests.some(({ method }) => method === 'DELETE')).toBe(false);
  });

  it('does not accept an unacknowledged control index creation', async () => {
    const elasticsearch = new StatefulElasticsearch();
    elasticsearch.createAcknowledged = false;
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    await expect(createClient('test').acquire('--apply')).rejects.toThrow('not acknowledged');
  });

  it('reports the recovery owner when acquisition has an unknown outcome', async () => {
    const elasticsearch = new StatefulElasticsearch();
    elasticsearch.lockCreateError = new Error('socket closed');
    vi.stubGlobal('fetch', vi.fn(elasticsearch.fetch));

    const error = await createClient('test')
      .acquire('--apply')
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ recoveryOwner: expect.any(String) });
    if (!(error instanceof FtsSearchMigrationLockError)) throw error;
    expect(error.message).toContain(`recover with owner ${error.recoveryOwner}`);
  });

  it('does not expose API keys or Elasticsearch error bodies', async () => {
    const secret = 'secret-api-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: `rejected ${secret}` }, 403)),
    );
    const client = new FtsSearchMigrationLockClient({
      apiKey: secret,
      namespace: 'test',
      url: 'https://search.example.com',
    });

    const error = await client.read().catch((cause: unknown) => cause);

    if (!(error instanceof FtsSearchMigrationLockError)) throw error;
    expect(error.message).toBe('Elasticsearch migration lock status failed (403)');
    expect(error.message).not.toContain(secret);
  });
});
