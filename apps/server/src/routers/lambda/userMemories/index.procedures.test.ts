// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { userMemoriesRouter } from '.';
import { queryRouter } from './query';
import { reEmbedRouter } from './reEmbed';
import { searchRouter } from './search';
import { toolWriteRouter } from './toolWrite';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('userMemoriesRouter procedures', () => {
  const procedures = (userMemoriesRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each([
    ['queryRouter', queryRouter],
    ['reEmbedRouter', reEmbedRouter],
    ['searchRouter', searchRouter],
    ['toolWriteRouter', toolWriteRouter],
  ])('%s declares its procedures in alphabetical order', (_name, subRouter) => {
    const names = Object.keys((subRouter as any)._def.procedures);
    expect(names).toEqual([...names].sort());
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<
  [name: string, type: 'mutation' | 'query' | 'subscription', middlewares: number]
> {
  return [
    ['getMemoryDetail', 'query', 12],
    ['queryActivities', 'query', 13],
    ['queryExperiences', 'query', 13],
    ['queryIdentities', 'query', 13],
    ['queryIdentitiesForInjection', 'query', 12],
    ['queryIdentityRoles', 'query', 12],
    ['queryMemories', 'query', 13],
    ['queryTags', 'query', 12],
    ['queryTaxonomyOptions', 'query', 12],
    ['reEmbedMemories', 'mutation', 13],
    ['retrieveMemoryForTopic', 'query', 13],
    ['searchMemory', 'query', 13],
    ['toolAddActivityMemory', 'mutation', 13],
    ['toolAddContextMemory', 'mutation', 13],
    ['toolAddExperienceMemory', 'mutation', 13],
    ['toolAddIdentityMemory', 'mutation', 13],
    ['toolAddPreferenceMemory', 'mutation', 13],
    ['toolRemoveIdentityMemory', 'mutation', 13],
    ['toolSearchMemory', 'query', 13],
    ['toolUpdateIdentityMemory', 'mutation', 13],
  ];
}
