import {
  jsonResponse,
  StatefulElasticsearch,
} from '../../runtime/__tests__/migrationLock.testUtils';

interface Index {
  aliases: Record<string, { is_write_index?: boolean }>;
  documents: Map<string, unknown>;
  mappings: Record<string, unknown>;
  settings: { analysis: Record<string, unknown> };
}

/** Stateful ES boundary shared by the parent and real CLI subprocess via IPC. */
export class ReindexElasticsearch {
  readonly locks = new StatefulElasticsearch();
  readonly indices = new Map<string, Index>();
  readonly bulkIds: string[] = [];
  readonly requests: string[] = [];
  failedBulks = 0;
  failSecondBulk = true;
  private bulkRequests = 0;

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [name, operation] = parts;
    if (name === '_tasks' || name?.endsWith('-fts-search-control'))
      return this.locks.fetch(input, init);
    if (name === '_bulk') {
      this.bulkRequests += 1;
      if (this.failSecondBulk && this.bulkRequests === 2) {
        this.failedBulks += 1;
        return jsonResponse({ error: 'injected second-batch failure' }, 500);
      }
      const lines = String(init.body).trim().split('\n');
      const items = [];
      for (let i = 0; i < lines.length; i += 2) {
        const { index } = JSON.parse(lines[i]);
        this.indices.get(index._index)!.documents.set(index._id, JSON.parse(lines[i + 1]));
        this.bulkIds.push(index._id);
        items.push({ index: { status: 201 } });
      }
      return jsonResponse({ items });
    }
    if (name === '_cat' && operation === 'indices') {
      const prefix = parts[2].replace(/\*$/, '');
      return jsonResponse(
        [...this.indices.keys()]
          .filter((index) => index.startsWith(prefix))
          .map((index) => ({ index, status: 'open' })),
      );
    }
    if (name === '_alias') {
      const entries = [...this.indices].filter(([, index]) =>
        Object.hasOwn(index.aliases, operation),
      );
      return entries.length
        ? jsonResponse(
            Object.fromEntries(entries.map(([name, index]) => [name, { aliases: index.aliases }])),
          )
        : jsonResponse({}, 404);
    }
    if (name === '_aliases') {
      for (const { add } of JSON.parse(String(init.body)).actions)
        this.indices.get(add.index)!.aliases[add.alias] = { is_write_index: add.is_write_index };
      return jsonResponse({ acknowledged: true });
    }
    if (method === 'PUT' && !operation) {
      if (this.indices.has(name))
        return jsonResponse({ error: { type: 'resource_already_exists_exception' } }, 400);
      const body = JSON.parse(String(init.body));
      this.indices.set(name, {
        aliases: {},
        mappings: body.mappings,
        settings: body.settings,
        documents: new Map(),
      });
      return jsonResponse({ acknowledged: true });
    }
    const index = this.indices.get(name);
    if (method === 'HEAD' && !operation) return jsonResponse({}, index ? 200 : 404);
    if (method === 'GET' && !operation) {
      const names = name.split(',');
      if (names.some((entry) => !this.indices.has(entry))) return jsonResponse({}, 404);
      return jsonResponse(
        Object.fromEntries(
          names.map((entry) => {
            const value = this.indices.get(entry)!;
            return [
              entry,
              {
                aliases: value.aliases,
                mappings: value.mappings,
                settings: { index: value.settings },
              },
            ];
          }),
        ),
      );
    }
    if (operation === '_count') return jsonResponse({ count: index?.documents.size ?? 0 });
    if (operation === '_refresh') return jsonResponse({ _shards: { failed: 0 } });
    if (operation === '_mapping' && index)
      return jsonResponse({ [name]: { mappings: index.mappings } });
    if (operation === '_settings' && index)
      return jsonResponse({ [name]: { settings: { index: index.settings } } });
    if (operation === '_alias' && index)
      return jsonResponse({ [name]: { aliases: index.aliases } });
    return jsonResponse({ error: `Unhandled ES test request: ${method} ${url.pathname}` }, 500);
  };
}
