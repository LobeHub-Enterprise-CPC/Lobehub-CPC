import type { MigrationTableItem } from '@lobechat/types';
import { sql } from 'drizzle-orm';

import { TENANT_MIGRATIONS_TABLE } from '../tenant/migrator';
import type { LobeChatDatabase } from '../type';

export class DrizzleMigrationModel {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  getTableCounts = async () => {
    // Tables of the tenant schema the connection is bound to (its search path).
    const result = await this.db.execute(
      sql`
        SELECT COUNT(*) as table_count
        FROM information_schema.tables
        WHERE table_schema = current_schema()
      `,
    );

    return parseInt((result.rows[0] as any).table_count || '0');
  };

  getMigrationList = async () => {
    // The tenant chain keeps its journal inside the tenant schema (spec FR-MD-01).
    const res = await this.db.execute(
      sql.raw(`SELECT * FROM "${TENANT_MIGRATIONS_TABLE}" ORDER BY "created_at" DESC;`),
    );

    return res.rows as unknown as MigrationTableItem[];
  };
  getLatestMigrationHash = async () => {
    const res = await this.getMigrationList();

    return res[0].hash;
  };
}
