// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { messengerRouter } from './index';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('messengerRouter procedures', () => {
  const procedures = (messengerRouter as any)._def.procedures as Record<string, any>;

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
    ['availablePlatforms', 'query', 11],
    ['confirmLink', 'mutation', 12],
    ['createLinqLink', 'mutation', 11],
    ['createWechatQrSession', 'mutation', 11],
    ['getMessengerPushWindow', 'query', 12],
    ['getMyLink', 'query', 12],
    ['listAgentsForBinding', 'query', 12],
    ['listBindingScopes', 'query', 11],
    ['listMyInstallations', 'query', 11],
    ['listMyLinks', 'query', 11],
    ['peekLinkToken', 'query', 7],
    ['pollLinqLink', 'query', 12],
    ['pollWechatQrSession', 'mutation', 12],
    ['sendMessengerPush', 'mutation', 12],
    ['setActiveAgent', 'mutation', 12],
    ['uninstallInstallation', 'mutation', 13],
    ['unlink', 'mutation', 13],
  ];
}
