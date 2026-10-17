# Tenant database readiness

Tenant identity comes from the trusted platform datasource bundle. Business schemas do not
duplicate it in a marker table. `schemaVersion` is a protocol compatibility declaration;
it is not proof that migrations completed.

## Verification

Provisioning, datasource rotation, request admission and external-work reconciliation use
the same database verification:

- Derive schema, owner and runtime names from the tenant ID; validate the bundle binding.
- Verify the actual runtime role, namespace owner, role attributes and schema privileges.
  Runtime cannot assume the owner, create objects, access other tenants/public, or write
  migration journals (including advancing their sequences).
- Compare every registered chain's applied entries, in ID order, with the release's original
  SQL hashes and exact timestamps. Readiness requires the entire chain. Migration accepts
  only a valid prefix; it never guesses from the largest timestamp.
- Check expected business tables and columns exist, their objects belong to the owner,
  and the runtime role has the required business DML and sequence privileges.

Request admission caches successful verification for at most five seconds, keyed by tenant,
connection version, credential bundle version and schema version. The control-plane readiness
endpoint always verifies the current connection. Maintenance uses the same verification
without imposing active-tenant admission, so frozen tenants can still be reconciled.

## Console orchestration contract

Console owns orchestration across CPC and Admin. It calls CPC's control plane using the
CPC service origin and the shared `LOBEHUB_CONTROL_PLANE_TOKEN` configured in CPC
(at least 32 characters). This contract does not prescribe Console's configuration names.

Admin does not configure a CPC control-plane URL or token and does not call CPC readiness.
It verifies its own migration history and schema, plus the supplied datasource bundles'
bindings, actual connections, schema ownership and runtime permissions. These checks do
not claim that CPC's complete business migrations have been applied.

Call `POST /api/internal/control-plane/tenant-readiness` with Bearer authentication and JSON:

```ts
{
  tenantId,
  datasource: {
    ...bundle,
    schemaOwner: { username: bundle.schemaOwner.username, role: bundle.schemaOwner.role },
    runtimeCredential: { username: bundle.runtimeCredential.username },
  },
}
```

Both password fields must be omitted; requests containing them are rejected. CPC compares
the complete remaining bundle with its current platform directory, verifies the actual
database and rechecks the binding to detect concurrent rotation. Missing or incomplete
provisioning cannot become ready through this endpoint. The operation is read-only.

The response has `Cache-Control: private, no-store`:

```ts
{
  tenantId,
  datasourceReady: true,
  connectionVersion,
  credentialBundleVersion,
  schemaName,
  schemaVersion,
  checkedAt, // ISO timestamp
  errorCode: null,
}
```

Success is HTTP 200. An unavailable datasource is HTTP 503 with `datasourceReady: false`
and `TENANT_NOT_READY` or `DATASOURCE_INVALID`. Authentication, malformed requests and a
conflicting `x-tenant-id` use the existing control-plane 401/400/403 errors.

Before reporting provisioning or datasource rotation as complete, Console must validate
this response's identity/versions against the current CPC bundle and confirm Admin's own
execution result separately. This is the required orchestration contract; Console's
implementation is not verified by this repository's readiness tests.

Admin does not need a CPC operation ID or a `lobehubOperationId` field. `getProvision`
remains an operation receipt, and no relationship between CPC and Admin
`operationId`/`rootOperationId` is assumed. After rotation, only the new bundle can pass
CPC readiness; a previous operation receipt is not current readiness evidence.

This verifies configuration and database state under trusted provisioning ownership. It
does not authenticate a database against a malicious database administrator, nor does a
successful response promise that a later database or credential change cannot occur.

## Durable execution and renewal

Operation IDs and lifecycle event IDs are global identities. Concurrent requests cannot
reassign an existing ID to another tenant or replace its immutable input. Conflicting
inserts return a conflict and roll back the receiving transaction.

Provision and lifecycle execution reuse the platform tables' existing lease token and
expiry columns. A live lease prevents another replica from starting the same work; an
expired lease can be reclaimed. Progress and terminal writes require the current token,
so a late failure from an earlier executor cannot overwrite the new result. Leases last
five minutes and renew between steps. A step exceeding that interval can be repeated
after takeover, so external steps must remain idempotent; this is not an exactly-once
side-effect guarantee.

The `expired` freeze reason is derived from `expiresAt`. Renewal to a future date or no
expiry removes that reason even if an older payload still carries it. Manual and security
freezes, explicit frozen state and offline state continue to block admission.

## Migration maintenance

SSO public configuration (`oauth2_config`, `oidc_config`, `saml_config`) uses typed JSONB
objects; SQL NULL represents an absent protocol configuration. Database checks reject
arrays, scalars and JSON null. `secret_config_encrypted` remains a text ciphertext envelope.
Admin writes objects and CPC reads objects, without a second JSON serialization layer.

The text-to-JSONB upgrade preserves the existing tenant migration prefix. A Drizzle custom
migration performs the explicit `USING column::jsonb` conversion, followed by a generated
schema diff that records the new types and object checks. Both run in the tenant migrator's
transaction. Invalid historical JSON or non-object configuration aborts the upgrade without
changing data or history. The separate conversion is necessary because the installed
drizzle-kit does not emit `USING` for this type change; generated SQL/snapshots are not patched.
Deploy CPC's tenant migrations before Admin starts writing JSONB to the mirrored table.
Coordinate the conversion with replacement of the old SSO readers: old instances expect
text and cannot consume the objects returned for JSONB. Use a maintenance rollout for
this schema change rather than leaving old and new readers active together.

The upstream business migration chain is unchanged. CPC's tenant-only chain contains SSO
providers and has a separate journal to avoid conflicts with future canary migration indices.
Generate it with `DRIZZLE_TARGET=tenant bunx drizzle-kit generate --name <semantic_name>`;
platform changes continue using `DRIZZLE_TARGET=platform`.

Each distribution `TenantMigrator` must supply `verify(client, context, allowPending)` in
addition to `run` and its journal names. Verification must cover its own complete history
and expected schema. All registered chains are checked before migration writes begin.

The draft tenant chain was regenerated without the redundant marker. Databases that ran
the earlier draft are rejected with `migration-history-mismatch`; their data and journal
are preserved. Do not clear a database, delete journal rows, or automatically rewrite old
hashes to bypass this refusal. A separately audited data-preserving transition is required
for any such persistent installation.
