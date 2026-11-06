// PostgreSQL transport adapter for the real reindex child: SQL runs against disposable PGlite.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

let database: Promise<PGlite> | undefined;
const open = () =>
  (database ??= (async () => {
    const db = await PGlite.create({
      dataDir: process.env.TEST_REINDEX_PGLITE_DIRECTORY!,
      extensions: { vector },
    });
    const schema = process.env.TEST_REINDEX_SCHEMA!;
    if (!/^tenant_[\da-f]{24}$/.test(schema)) throw new Error('Invalid test schema');
    await db.exec(`SET search_path TO "${schema}", public`);
    return db;
  })());

interface Query {
  rowMode?: 'array';
  text: string;
}

export class Pool {
  on() {
    return this;
  }
  async connect() {
    return { query: this.query.bind(this), release: () => {} };
  }
  async end() {
    if (database) await (await database).close();
  }
  async query(query: string | Query, params: unknown[] = []) {
    const db = await open();
    const text = typeof query === 'string' ? query : query.text;
    const result = await db.query(text, params, {
      rowMode: typeof query === 'string' ? undefined : query.rowMode,
      // Match node-postgres/Drizzle's string timestamp decoding.
      parsers: { 1082: (value) => value, 1114: (value) => value, 1184: (value) => value },
    });
    return { ...result, command: '', oid: 0, rowCount: result.affectedRows ?? result.rows.length };
  }
}

export class Client extends Pool {}
export default { Pool, Client };
