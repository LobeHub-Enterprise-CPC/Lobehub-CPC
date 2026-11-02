// @vitest-environment node
import { MarketAPIError } from '@lobehub/market-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureMarketSkills, ensureMarketSkillsInputSchema } from './ensure';
import { SkillImportError } from './errors';

vi.mock('@lobechat/builtin-skills/manifests', () => ({
  builtinSkillManifests: [{ identifier: 'builtin-skill' }],
}));
vi.mock('@lobechat/builtin-tools/identifiers', () => ({
  builtinToolIdentifiers: ['builtin-tool'],
}));

const deps = {
  marketService: {
    getSkillDetail: vi.fn(),
    downloadSkill: vi.fn(),
    getSkillDownloadUrl: vi.fn((id: string) => `https://market.example/skills/${id}/download`),
  },
  skillImporter: { importFromMarketZip: vi.fn() },
  skillModel: { findByIdentifier: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  deps.marketService.getSkillDetail.mockResolvedValue({ name: 'Market Skill' });
  deps.skillModel.findByIdentifier.mockResolvedValue(undefined);
  deps.marketService.downloadSkill.mockImplementation(async (id: string) => ({
    buffer: new TextEncoder().encode(`zip:${id}`).buffer,
  }));
  deps.skillImporter.importFromMarketZip.mockResolvedValue({ status: 'created' });
});

describe('ensureMarketSkills', () => {
  it('normalizes identifiers before applying the batch limit', () => {
    expect(
      ensureMarketSkillsInputSchema.parse({ identifiers: [' a ', '', ' ', 'a', 'b'] }),
    ).toEqual({ identifiers: ['a', 'b'] });
    expect(
      ensureMarketSkillsInputSchema.safeParse({
        identifiers: Array.from({ length: 51 }, (_, i) => `${i}`),
      }).success,
    ).toBe(false);
    expect(
      ensureMarketSkillsInputSchema.parse({ identifiers: Array.from({ length: 60 }, () => 'a') }),
    ).toEqual({ identifiers: ['a'] });
  });

  it('skips builtins without querying or importing them', async () => {
    expect(await ensureMarketSkills(['builtin-tool', 'builtin-skill'], deps)).toEqual([
      { identifier: 'builtin-tool', status: 'skipped' },
      { identifier: 'builtin-skill', status: 'skipped' },
    ]);
    expect(deps.skillModel.findByIdentifier).not.toHaveBeenCalled();
    expect(deps.marketService.getSkillDetail).not.toHaveBeenCalled();
    expect(deps.skillImporter.importFromMarketZip).not.toHaveBeenCalled();
  });

  it('preserves existing market skills and rejects other sources, even with the same source URL', async () => {
    deps.skillModel.findByIdentifier.mockImplementation(async (identifier) => ({
      identifier,
      manifest: { sourceUrl: `https://market.example/skills/${identifier}/download` },
      source: identifier === 'installed' ? 'market' : 'user',
    }));
    expect(await ensureMarketSkills(['installed', 'conflicting'], deps)).toEqual([
      { identifier: 'installed', status: 'installed' },
      { identifier: 'conflicting', reason: 'conflict', status: 'failed' },
    ]);
    expect(deps.marketService.getSkillDetail).not.toHaveBeenCalled();
    expect(deps.skillImporter.importFromMarketZip).not.toHaveBeenCalled();
  });

  it('downloads through the authenticated Market client and imports without overwrite', async () => {
    // A tenant-scoped Market only serves the package to the request's own
    // credentials; an anonymous fetch of the public download URL 404s.
    expect(await ensureMarketSkills(['new'], deps)).toEqual([
      { identifier: 'new', status: 'installed' },
    ]);
    expect(deps.marketService.downloadSkill).toHaveBeenCalledWith('new');
    expect(deps.skillImporter.importFromMarketZip).toHaveBeenCalledWith(Buffer.from('zip:new'), {
      identifier: 'new',
      overwrite: false,
      sourceUrl: 'https://market.example/skills/new/download',
    });
  });

  it('reports a download failure when the authenticated download fails', async () => {
    deps.marketService.downloadSkill.mockRejectedValue(
      new SkillImportError('Failed to download skill from Market', 'DOWNLOAD_FAILED'),
    );
    expect(await ensureMarketSkills(['new'], deps)).toEqual([
      { identifier: 'new', reason: 'download', status: 'failed' },
    ]);
    expect(deps.skillImporter.importFromMarketZip).not.toHaveBeenCalled();
  });

  it.each([
    [new MarketAPIError(404, 'Not Found'), 'notSkill'],
    [new MarketAPIError(403, 'Forbidden'), 'failed'],
    [new MarketAPIError(503, 'Unavailable'), 'failed'],
    [new Error('404 Not Found'), 'failed'],
    [Object.assign(new Error('Not Found'), { status: 404 }), 'failed'],
    [new TypeError('Network failed'), 'failed'],
  ])('classifies only typed detail 404 as notSkill (%s)', async (error, status) => {
    deps.marketService.getSkillDetail.mockRejectedValue(error);
    expect(await ensureMarketSkills(['missing'], deps)).toEqual([
      expect.objectContaining({
        identifier: 'missing',
        status,
        ...(status === 'failed' && { reason: 'unavailable' }),
      }),
    ]);
    expect(deps.skillImporter.importFromMarketZip).not.toHaveBeenCalled();
  });

  it.each([
    [new SkillImportError('Download 404', 'NOT_FOUND'), 'download'],
    [new Error('Invalid manifest'), 'download'],
    [new SkillImportError('Same name exists', 'CONFLICT'), 'conflict'],
  ])('keeps download failures and source conflicts distinct (%s)', async (error, reason) => {
    deps.skillImporter.importFromMarketZip.mockRejectedValue(error);
    expect(await ensureMarketSkills(['new'], deps)).toEqual([
      expect.objectContaining({ identifier: 'new', reason, status: 'failed' }),
    ]);
  });

  describe('when the import fails', () => {
    // The unique constraint rejects the loser of two concurrent installs.
    const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });

    it('reports installed when a concurrent request already installed the Market skill', async () => {
      deps.skillModel.findByIdentifier
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ identifier: 'new', source: 'market' });
      deps.skillImporter.importFromMarketZip.mockRejectedValue(uniqueViolation);

      expect(await ensureMarketSkills(['new'], deps)).toEqual([
        { identifier: 'new', status: 'installed' },
      ]);
    });

    it('keeps the download failure when nothing was installed meanwhile', async () => {
      deps.skillImporter.importFromMarketZip.mockRejectedValue(uniqueViolation);

      expect(await ensureMarketSkills(['new'], deps)).toEqual([
        { identifier: 'new', reason: 'download', status: 'failed' },
      ]);
    });

    it('reports a conflict when the identifier is now taken by another source', async () => {
      deps.skillModel.findByIdentifier
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ identifier: 'new', source: 'user' });
      deps.skillImporter.importFromMarketZip.mockRejectedValue(uniqueViolation);

      expect(await ensureMarketSkills(['new'], deps)).toEqual([
        { identifier: 'new', reason: 'conflict', status: 'failed' },
      ]);
    });

    it('keeps the original classification when the re-check itself fails', async () => {
      deps.skillModel.findByIdentifier
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('DB unavailable'));
      deps.skillImporter.importFromMarketZip.mockRejectedValue(new Error('Invalid manifest'));

      expect(await ensureMarketSkills(['new'], deps)).toEqual([
        { identifier: 'new', reason: 'download', status: 'failed' },
      ]);
    });
  });

  it('isolates per-item storage lookup errors', async () => {
    deps.skillModel.findByIdentifier.mockRejectedValueOnce(new Error('DB unavailable'));
    const result = await ensureMarketSkills(['broken', 'new'], deps);
    expect(result[0]).toMatchObject({ reason: 'unavailable', status: 'failed' });
    expect(result[1]).toEqual({ identifier: 'new', status: 'installed' });
  });

  it('limits concurrent work to four and preserves input order', async () => {
    const identifiers = Array.from({ length: 9 }, (_, i) => `skill-${i}`);
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    deps.marketService.getSkillDetail.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
      return {};
    });
    const pending = ensureMarketSkills(identifiers, deps);
    while (deps.marketService.getSkillDetail.mock.calls.length < 4)
      await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(4);
    while (release.length || active) {
      release.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await pending).toEqual(
      identifiers.map((identifier) => ({ identifier, status: 'installed' })),
    );
    expect(peak).toBe(4);
  });
});
