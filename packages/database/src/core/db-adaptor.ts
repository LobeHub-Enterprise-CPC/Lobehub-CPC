import { tenantDB } from '../tenant/requestScope';
import type { LobeChatDatabase } from '../type';

/**
 * The business database of the current tenant (spec A15, FR-DI-09).
 *
 * There is no process-wide business database any more: every business and
 * auth table lives in a tenant schema, and the handle resolves the tenant the
 * current request or job established (`runWithTenantScope`) on every access.
 * Outside a tenant scope any use fails with `TENANT_REQUIRED`; it never falls
 * back to the platform connection or a default tenant.
 *
 * The platform connection (`DATABASE_URL`, routing metadata only) is
 * `getPlatformDB()` in `@lobechat/database/platform`.
 */
export const serverDB: LobeChatDatabase = tenantDB;

export const getServerDB = async (): Promise<LobeChatDatabase> => tenantDB;
