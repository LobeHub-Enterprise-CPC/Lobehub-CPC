import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LOBEHUB_TENANT_SCHEMA_VERSION } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  bundle,
  lifecycle,
  provision,
  provisionApplied,
  resetService,
  rotate,
  TENANT,
} from './__tests__/service.testUtils';
import {
  datasourceRequestSchema,
  lifecycleRequestSchema,
  provisionRequestSchema,
} from './contracts';
import { validateDatasourceBundle } from './datasource';
import { tenantManifest } from './manifest';

// contracts/tenant-control-plane is Console's, byte-identical here (`bun run contracts:check` in
// Console). Its zod schemas are the source of schemas.json and fixtures.json; this application's
// receiving schemas and its real results are held to the same files.
const read = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`./../../../../../contracts/tenant-control-plane/${name}`, import.meta.url),
      ),
      'utf8',
    ),
  );
const fixtures = read('fixtures.json') as {
  cases: { accepts: boolean; id: string; schema: string; value: any }[];
};
const published = read('schemas.json') as {
  schemas: Record<
    string,
    { apps: string[]; direction: 'request' | 'response'; jsonSchema: object }
  >;
};

/**
 * Does this application take the message? A bundle is checked in two steps, as the service does:
 * the wire schema (a 400), then the derivation against the tenant (a recorded DATASOURCE_INVALID).
 */
const takes: Record<string, (value: any) => boolean> = {
  lifecycleRequest: (value) => lifecycleRequestSchema.safeParse(value).success,
  lobehubDatasourceRequest: (value) => {
    const parsed = datasourceRequestSchema.safeParse(value);
    return (
      parsed.success &&
      parsed.data.tenantId === parsed.data.datasource.tenantId &&
      validateDatasourceBundle(parsed.data.tenantId, parsed.data.datasource) === null
    );
  },
  lobehubProvisionRequest: (value) => {
    const parsed = provisionRequestSchema.safeParse(value);
    return (
      parsed.success &&
      validateDatasourceBundle(parsed.data.tenantId, parsed.data.datasource) === null
    );
  },
};

const mine = (name: string) => published.schemas[name]?.apps.includes('lobehub');

describe('TITU Work receives what Console sends', () => {
  it('knows every request the contract addresses to it', () => {
    const requests = Object.keys(published.schemas).filter(
      (name) => mine(name) && published.schemas[name].direction === 'request',
    );
    expect(requests.sort()).toEqual(
      Object.keys(takes)
        .filter((name) => published.schemas[name]?.direction === 'request')
        .sort(),
    );
  });

  it.each(
    fixtures.cases
      .filter((c) => mine(c.schema) && published.schemas[c.schema].direction === 'request')
      .map((c) => [c.id, c] as const),
  )('%s', (_id, { accepts, schema, value }) => {
    expect(takes[schema](value)).toBe(accepts);
  });
});

describe('what TITU Work answers is what Console parses', () => {
  let service: ReturnType<typeof resetService>['service'];
  beforeEach(() => {
    ({ service } = resetService());
  });
  const conforms = (name: string, value: unknown) => {
    const schema = z.fromJSONSchema(published.schemas[name].jsonSchema as never);
    const result = schema.safeParse(value);
    expect(result.error?.issues ?? [], name).toEqual([]);
  };

  it('answers provision, in flight and applied', async () => {
    conforms('provisionResult', await service.receiveProvision(provision()));
    await service.executeProvision(TENANT, 'root-1:lobehub');
    conforms('provisionResult', await service.getProvision(TENANT, 'root-1:lobehub'));
  });

  it('answers a failed provision with its code', async () => {
    conforms('provisionResult', await service.receiveProvision(provision({ slug: 'admin' })));
  });

  it('answers tenant-manifest with the schema version it provisions', () => {
    conforms('lobehubManifest', tenantManifest());
    expect(tenantManifest().schemaVersion).toBe(LOBEHUB_TENANT_SCHEMA_VERSION);
  });

  it('answers datasource rotation', async () => {
    await provisionApplied();
    conforms('datasourceResult', await service.receiveDatasource(rotate()));
  });

  it('answers lifecycle and overview', async () => {
    await provisionApplied();
    conforms('lifecycleResult', await service.receiveLifecycle(lifecycle()));
    conforms('overview', await service.getOverview(TENANT));
  });

  it('keeps the fixtures the contract publishes for these answers valid too', () => {
    for (const { accepts, schema, value } of fixtures.cases)
      if (accepts && mine(schema) && published.schemas[schema].direction === 'response')
        conforms(schema, value);
  });

  it('builds its sample bundle from the contract names', () => {
    expect(validateDatasourceBundle(TENANT, bundle())).toBeNull();
  });
});
