import { beforeEach, describe, expect, it } from 'vitest';

import {
  bundle,
  provision,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';
import { profileRequestSchema } from './contracts';

const OTHER = '9b1d4e6f-2222-4333-8444-a55566667777';

let repo: ReturnType<typeof resetService>['repo'];
let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, db, service } = resetService());
});

const profile = (over: Record<string, unknown> = {}) => ({
  eventId: 'profile:1',
  formerSlugs: ['acme'],
  name: 'Acme Corp',
  slug: 'acme-corp',
  tenantId: TENANT,
  version: 2,
  ...over,
});

describe('profileRequestSchema', () => {
  it('takes exactly the contract shape', () => {
    expect(profileRequestSchema.safeParse(profile()).success).toBe(true);
    expect(profileRequestSchema.safeParse(profile({ extra: 1 })).success).toBe(false);
  });

  it.each([
    ['version 1 is the provision itself', { version: 1 }],
    ['an empty name', { name: '   ' }],
    ['a name over 256 characters', { name: 'x'.repeat(257) }],
    ['a malformed slug', { slug: 'Not A Slug' }],
    ['a malformed former slug', { formerSlugs: ['A_B'] }],
    ['the current slug among the former ones', { formerSlugs: ['acme-corp'] }],
    ['a repeated former slug', { formerSlugs: ['acme', 'acme'] }],
  ])('refuses %s', (_label, over) => {
    expect(profileRequestSchema.safeParse(profile(over)).success).toBe(false);
  });

  it('trims the name', () => {
    expect(profileRequestSchema.parse(profile({ name: '  Acme Corp ' })).name).toBe('Acme Corp');
  });
});

describe('receiveProfile', () => {
  it('is not found for a tenant that is not provisioned here', async () => {
    await expect(service.receiveProfile(profile())).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
      status: 404,
    });
    await service.receiveProvision(provision());
    await expect(service.receiveProfile(profile())).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });

  it('applies a newer version: name, slug, aliases and version in one step', async () => {
    await provisionApplied();
    const result = await service.receiveProfile(profile());
    expect(result).toEqual({
      acceptedVersion: 2,
      appliedVersion: 2,
      errorCode: null,
      eventId: 'profile:1',
      name: 'Acme Corp',
      observedAt: expect.any(String),
      slug: 'acme-corp',
      status: 'applied',
      tenantId: TENANT,
      version: 2,
    });
    expect(repo.directory.get(TENANT)!.record).toMatchObject({
      name: 'Acme Corp',
      profileVersion: 2,
      slug: 'acme-corp',
    });
    expect(repo.aliases.get('acme')).toBe(TENANT);
  });

  it('replaces the alias set with the former slugs it is sent', async () => {
    await provisionApplied();
    await service.receiveProfile(profile());
    await service.receiveProfile(
      profile({ formerSlugs: ['acme', 'acme-corp'], slug: 'acme-inc', version: 3 }),
    );
    expect([...repo.aliases].sort()).toEqual([
      ['acme', TENANT],
      ['acme-corp', TENANT],
    ]);
    // Renaming back: the slug leaves the alias set and the one it replaced joins it.
    await service.receiveProfile(
      profile({ formerSlugs: ['acme-corp', 'acme-inc'], slug: 'acme', version: 4 }),
    );
    expect(repo.directory.get(TENANT)!.record.slug).toBe('acme');
    expect([...repo.aliases.keys()].sort()).toEqual(['acme-corp', 'acme-inc']);
  });

  it('supersedes an older version and changes nothing', async () => {
    await provisionApplied();
    await service.receiveProfile(profile({ version: 3 }));
    const result = await service.receiveProfile(
      profile({
        eventId: 'profile:old',
        formerSlugs: [],
        name: 'Older',
        slug: 'older',
        version: 2,
      }),
    );
    expect(result).toMatchObject({
      acceptedVersion: 3,
      appliedVersion: 3,
      name: 'Acme Corp',
      slug: 'acme-corp',
      status: 'superseded',
      version: 2,
    });
    expect(repo.directory.get(TENANT)!.record).toMatchObject({
      profileVersion: 3,
      slug: 'acme-corp',
    });
    expect(repo.aliases.has('older')).toBe(false);
  });

  it('answers a repeated version with the same content as applied', async () => {
    await provisionApplied();
    await service.receiveProfile(profile({ formerSlugs: ['acme', 'older'] }));
    const again = await service.receiveProfile(profile({ formerSlugs: ['older', 'acme'] }));
    expect(again).toMatchObject({ appliedVersion: 2, slug: 'acme-corp', status: 'applied' });
  });

  it.each([
    ['name', { name: 'Another' }],
    ['slug', { slug: 'another' }],
    ['former slugs', { formerSlugs: [] }],
    ['seat limit', { seatLimit: 7 }],
  ])('refuses a repeated version with a different %s', async (_label, over) => {
    await provisionApplied();
    await service.receiveProfile(profile({ seatLimit: 5 }));
    await expect(service.receiveProfile(profile({ seatLimit: 5, ...over }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    expect(repo.directory.get(TENANT)!.record).toMatchObject({
      name: 'Acme Corp',
      slug: 'acme-corp',
    });
  });

  describe('seat limit', () => {
    it('takes the limit from provision and keeps it when a profile omits it', async () => {
      await provisionApplied(provision({ seatLimit: 20 }));
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(20);
      await service.receiveProfile(profile());
      expect(repo.directory.get(TENANT)!.record).toMatchObject({
        profileVersion: 2,
        seatLimit: 20,
      });
    });

    it('is no limit when provision sends none or null', async () => {
      await provisionApplied();
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBeNull();
      await service.receiveProfile(profile({ seatLimit: 3 }));
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(3);
    });

    it('sets, changes and clears the limit with a newer version', async () => {
      await provisionApplied();
      await service.receiveProfile(profile({ seatLimit: 10 }));
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(10);
      await service.receiveProfile(profile({ seatLimit: 4, version: 3 }));
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(4);
      await service.receiveProfile(profile({ seatLimit: null, version: 4 }));
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBeNull();
    });

    it('acknowledges a replay with the same limit, and one that omits it, as applied', async () => {
      await provisionApplied();
      await service.receiveProfile(profile({ seatLimit: 10 }));
      for (const replay of [profile({ seatLimit: 10 }), profile()])
        expect(await service.receiveProfile(replay)).toMatchObject({
          appliedVersion: 2,
          status: 'applied',
        });
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(10);
    });

    it('does not apply the limit of a superseded version', async () => {
      await provisionApplied();
      await service.receiveProfile(profile({ seatLimit: 10, version: 3 }));
      await service.receiveProfile(profile({ seatLimit: 1, version: 2 }));
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(10);
    });

    it('keeps a limit set after provision when the provision is retried', async () => {
      const request = provision({ seatLimit: 20 });
      await service.receiveProvision(request);
      db.verify.mockRejectedValueOnce(new Error('transient'));
      expect((await service.executeProvision(TENANT, request.operationId)).status).toBe('failed');
      await service.receiveProfile(profile({ seatLimit: 8 }));
      await service.receiveProvision(request);
      expect((await service.executeProvision(TENANT, request.operationId)).status).toBe('applied');
      expect(repo.directory.get(TENANT)!.record.seatLimit).toBe(8);
    });

    it.each([0, -1, 1.5, 1_000_001, '5'])('refuses the limit %s', (seatLimit) => {
      expect(profileRequestSchema.safeParse(profile({ seatLimit })).success).toBe(false);
    });

    it('takes null and an integer in range', () => {
      for (const seatLimit of [null, 1, 1_000_000])
        expect(profileRequestSchema.safeParse(profile({ seatLimit })).success).toBe(true);
    });
  });

  describe('slug conflicts', () => {
    beforeEach(async () => {
      await provisionApplied();
      await provisionApplied(
        provision({
          datasource: bundle(OTHER),
          name: 'Globex',
          operationId: 'root-2:lobehub',
          slug: 'globex',
          tenantId: OTHER,
        }),
      );
      repo.aliases.set('globex-old', OTHER);
    });

    it.each([
      ['another tenant slug', { slug: 'globex' }],
      ['another tenant alias', { slug: 'globex-old' }],
      ['a former slug that is another tenant slug', { formerSlugs: ['acme', 'globex'] }],
      ['a former slug that is another tenant alias', { formerSlugs: ['globex-old'] }],
    ])('refuses %s and writes nothing', async (_label, over) => {
      await expect(service.receiveProfile(profile(over))).rejects.toMatchObject({
        code: 'SLUG_CONFLICT',
        status: 409,
      });
      expect(repo.directory.get(TENANT)!.record).toMatchObject({ profileVersion: 1, slug: 'acme' });
      expect(repo.aliases.has('acme')).toBe(false);
    });

    it('refuses a slug the deployment does not register', async () => {
      await expect(service.receiveProfile(profile({ slug: 'admin' }))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        status: 400,
      });
    });
  });

  it('reports the renamed slug in the overview', async () => {
    await provisionApplied();
    await service.receiveProfile(profile());
    expect(await service.getOverview(TENANT)).toMatchObject({ slug: 'acme-corp' });
  });

  it('keeps the tenant renamed when its provision is replayed', async () => {
    const request = provision();
    await provisionApplied(request);
    await service.receiveProfile(profile());
    const replay = await service.receiveProvision(request);
    expect(replay).toMatchObject({ operationId: request.operationId, status: 'applied' });
    await service.executeProvision(TENANT, request.operationId);
    expect(repo.directory.get(TENANT)!.record).toMatchObject({
      name: 'Acme Corp',
      profileVersion: 2,
      slug: 'acme-corp',
    });
  });

  it('keeps the profile when a provision that already registered the directory is retried', async () => {
    const request = provision();
    await service.receiveProvision(request);
    db.verify.mockRejectedValueOnce(new Error('transient'));
    expect((await service.executeProvision(TENANT, request.operationId)).status).toBe('failed');
    await service.receiveProfile(profile());
    expect(await service.receiveProvision(request)).toMatchObject({ status: 'received' });
    expect((await service.executeProvision(TENANT, request.operationId)).status).toBe('applied');
    expect(repo.directory.get(TENANT)!.record).toMatchObject({
      name: 'Acme Corp',
      profileVersion: 2,
      slug: 'acme-corp',
      status: 'active',
    });
  });

  it('does not let another tenant provision under a former slug of a renamed one', async () => {
    await provisionApplied();
    await service.receiveProfile(profile({ formerSlugs: ['acme', 'older'] }));
    for (const slug of ['acme', 'older'])
      await expect(
        service.receiveProvision(
          provision({
            datasource: bundle(OTHER),
            operationId: `root-${slug}:lobehub`,
            slug,
            tenantId: OTHER,
          }),
        ),
      ).rejects.toMatchObject({ code: 'TENANT_INVALID', status: 409 });
  });
});
