// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { sandboxStorageRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('sandboxStorageRouter procedures', () => {
  const procedures = (sandboxStorageRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
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
    ['copyInstance', 'mutation', 16],
    ['createDirectory', 'mutation', 16],
    ['createEnvironment', 'mutation', 16],
    ['createInstance', 'mutation', 16],
    ['createInstanceForEnvironment', 'mutation', 16],
    ['getEntitlement', 'query', 12],
    ['getInstance', 'query', 16],
    ['getStorage', 'query', 13],
    ['instanceBuildStatus', 'query', 16],
    ['listEnvironments', 'query', 15],
    ['listFiles', 'query', 16],
    ['listGithubBranches', 'query', 14],
    ['listGithubRepositories', 'query', 13],
    ['listInstanceSessions', 'query', 16],
    ['listInstances', 'query', 16],
    ['readFile', 'query', 16],
    ['refreshStorageUsage', 'mutation', 13],
    ['removeEnvironment', 'mutation', 16],
    ['removeFile', 'mutation', 16],
    ['removeInstance', 'mutation', 16],
    ['renameInstance', 'mutation', 16],
    ['resolveSessionPlacement', 'query', 13],
    ['setEnvironmentVisibility', 'mutation', 15],
    ['startInstanceBuild', 'mutation', 16],
    ['stopInstance', 'mutation', 16],
    ['updateEnvironment', 'mutation', 15],
    ['writeFile', 'mutation', 16],
  ];
}
