import type { TenantMigrator } from '@lobechat/database/tenant';

/**
 * Business slot for the tenant migration chains a distribution runs after
 * the OSS chain (spec FR-MD-01). The tenant executor calls it once, with
 * `registerTenantMigrator`, before any chain runs, so provisioning (control
 * plane), `db:migrate` and the Docker image's startup upgrade all run the same
 * chains in the same order.
 *
 * The open-source build registers nothing. A distribution replaces this
 * package (a pnpm override, like the other `@lobechat/business-*` slots) and
 * registers its chain, e.g. Enterprise:
 * `registerBusinessTenantMigrators = (register) => registerEnterpriseTenantMigrator(register)`.
 */
export const registerBusinessTenantMigrators = (
  _register: (migrator: TenantMigrator) => void,
): void => {};

/**
 * Registration allow-list a distribution keeps in every tenant schema, one
 * entry per row in the `AUTH_ALLOWED_EMAILS` grammar: a full address, or a bare
 * domain that covers every address under it (trimmed, case-insensitive).
 *
 * The organization finder treats a listed address that has not signed up yet as
 * belonging to that tenant, so the account lookup role is granted `SELECT` on
 * exactly this column. The open-source build has no allow-list.
 */
export const businessTenantAllowList: { column: string; table: string } | undefined = undefined;
