import type { MigrationMeta } from 'drizzle-orm/migrator';

/**
 * Reviewed source identities, not proof of current extension/index readiness.
 * Approval: 1017-mthost-deploy/049r1-chatgpt-reissued-review.md (plan A).
 * Upstream deliberately reissued these files in PR #20944 so installations
 * without pg_search can migrate. On the installed branch the definitions are
 * unchanged (public and tenant catalogs compared on ParadeDB 0.25.3).
 * No compensation DDL or journal updates. Keep these rules while persisted
 * tenants with the original hashes remain supported; never derive A -> C
 * from A -> B. Every new target needs its own review and catalog evidence.
 */
const REVIEWED_SHARED_OSS_REISSUES = [
  {
    index: 90,
    tag: '0090_enable_pg_search',
    when: 1773115333051,
    originalCommit: '258e9cb9825534d1affae6565e648b87a2dfadb9',
    originalHash: 'f5ff69f21db850b260ca8f3be5e615b78a7425fb030d0ca42a963e9d0c0e0f91',
    targetHash: '5444829f18eecc8ffdf28d18a2d2bbd64a666018b065c2ed9e76eeb7c2836e6d',
  },
  {
    index: 93,
    tag: '0093_add_bm25_indexes_with_icu',
    when: 1773653550268,
    originalCommit: 'cec079d34b05ac52029b1dc17f1c76b7b4ffd562',
    originalHash: 'ae390b474eaaacfc943db4762348aac5bbc7a87af1bcdf99737719d04fd7e7bc',
    targetHash: 'a5bf012f7128abd95e3bdab5af10383decfecd0c1766bc9d6eb98ee2d6152a4a',
  },
] as const;
// Both target files were introduced by 406f6afecc9fe07420fd08807aa7128a36b60d94.

/** Only the official shared-OSS call site may use this predicate. */
export const matchesReviewedSharedOssReissue = (
  recordedHash: string,
  migration: MigrationMeta,
  metadata: unknown,
  index: number,
): boolean => {
  if (!metadata || typeof metadata !== 'object') return false;
  const entry = metadata as { idx?: unknown; tag?: unknown; when?: unknown };
  return REVIEWED_SHARED_OSS_REISSUES.some(
    (rule) =>
      index === rule.index &&
      entry.idx === index &&
      entry.tag === rule.tag &&
      entry.when === rule.when &&
      migration.folderMillis === rule.when &&
      migration.hash === rule.targetHash &&
      recordedHash === rule.originalHash,
  );
};
