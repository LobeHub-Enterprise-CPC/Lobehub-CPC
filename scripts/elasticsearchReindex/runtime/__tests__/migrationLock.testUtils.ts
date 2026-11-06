interface StoredDocument {
  primaryTerm: number;
  seqNo: number;
  source: { acquiredAt: string; command: string; owner: string };
}

interface StoredIndex {
  document?: StoredDocument;
  mappings: Record<string, unknown>;
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

export class StatefulElasticsearch {
  readonly indexes = new Map<string, StoredIndex>();
  readonly requests: Array<{ body?: string; method: string; pathname: string }> = [];

  beforeNextDelete?: () => void;
  createAcknowledged = true;
  createFailure?: { body: unknown; status: number };
  lockCreateError?: Error;
  lockDeleteBody?: unknown;
  lockReadBody?: unknown;
  lockReadStatus?: number;
  tasks: unknown = { nodes: {} };
  tasksStatus = 200;

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? 'GET';
    this.requests.push({
      body: typeof init.body === 'string' ? init.body : undefined,
      method,
      pathname: `${url.pathname}${url.search}`,
    });
    if (url.pathname === '/_tasks') return jsonResponse(this.tasks, this.tasksStatus);
    const [rawIndex, operation, rawDocumentId] = url.pathname.split('/').filter(Boolean);
    const indexName = rawIndex ? decodeURIComponent(rawIndex) : '';
    const index = this.indexes.get(indexName);

    if (method === 'PUT' && operation === undefined) {
      if (this.createFailure) {
        return jsonResponse(this.createFailure.body, this.createFailure.status);
      }
      if (index) return jsonResponse({ error: { type: 'resource_already_exists_exception' } }, 400);
      const body = JSON.parse(String(init.body)) as { mappings: Record<string, unknown> };
      this.indexes.set(indexName, { mappings: body.mappings });
      return jsonResponse({ acknowledged: this.createAcknowledged, index: indexName });
    }

    if (method === 'GET' && operation === '_mapping') {
      if (!index) return jsonResponse({ found: false }, 404);
      return jsonResponse({ [indexName]: { mappings: index.mappings } });
    }

    if (method === 'PUT' && operation === '_create' && rawDocumentId === 'migration-lock') {
      if (this.lockCreateError) throw this.lockCreateError;
      if (!index) return jsonResponse({ found: false }, 404);
      if (index.document)
        return jsonResponse({ error: { type: 'version_conflict_engine_exception' } }, 409);
      index.document = {
        primaryTerm: 1,
        seqNo: 0,
        source: JSON.parse(String(init.body)),
      };
      return jsonResponse({ _primary_term: 1, _seq_no: 0, result: 'created' }, 201);
    }

    if (method === 'GET' && operation === '_doc' && rawDocumentId === 'migration-lock') {
      if (this.lockReadStatus) return jsonResponse(this.lockReadBody ?? {}, this.lockReadStatus);
      if (this.lockReadBody !== undefined) return jsonResponse(this.lockReadBody);
      if (!index?.document) return jsonResponse({ found: false }, 404);
      return jsonResponse({
        _primary_term: index.document.primaryTerm,
        _seq_no: index.document.seqNo,
        _source: index.document.source,
        found: true,
      });
    }

    if (method === 'DELETE' && operation === '_doc' && rawDocumentId === 'migration-lock') {
      this.beforeNextDelete?.();
      this.beforeNextDelete = undefined;
      const current = this.indexes.get(indexName)?.document;
      if (!current) return jsonResponse({ result: 'not_found' }, 404);
      if (
        Number(url.searchParams.get('if_seq_no')) !== current.seqNo ||
        Number(url.searchParams.get('if_primary_term')) !== current.primaryTerm
      ) {
        return jsonResponse({ error: { type: 'version_conflict_engine_exception' } }, 409);
      }
      delete this.indexes.get(indexName)?.document;
      return jsonResponse(this.lockDeleteBody ?? { result: 'deleted' });
    }

    return jsonResponse({ error: { type: 'unhandled_request' } }, 500);
  };
}
