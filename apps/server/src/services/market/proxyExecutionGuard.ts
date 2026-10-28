import { type MarketSDK } from '@lobehub/market-sdk';

/**
 * Raised when a run that executes under someone else's identity (an Agent Share
 * visitor's run executes as the CREATOR) tries to publish or change Market
 * content. The creator did not ask for it and the visitor holds no Market
 * identity of their own, so nobody is entitled to be recorded as its author.
 */
export class MarketContentWriteForbiddenError extends Error {
  constructor(operation: string) {
    super(`MARKET_CONTENT_WRITE_FORBIDDEN:${operation}`);
    this.name = 'MarketContentWriteForbiddenError';
  }
}

/** SDK namespaces whose write verbs publish or change Market content. */
const CONTENT_NAMESPACES = new Set<PropertyKey>([
  'agentGroups',
  'agentProfile',
  'agents',
  'userPublish',
]);

const CONTENT_WRITE_VERB =
  /^(?:archive|claim|create|delete|deprecate|fork|modify|publish|submit|unpublish|update|upload)/;

/**
 * Wraps an SDK so the content namespaces refuse their write verbs. Reads, the
 * sandbox / skill / credential surface and everything else pass through
 * untouched: a proxy run needs those, and none of them records an author.
 */
export const guardProxyExecution = (sdk: MarketSDK): MarketSDK =>
  new Proxy(sdk, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!CONTENT_NAMESPACES.has(property) || typeof value !== 'object' || value === null) {
        return value;
      }

      return new Proxy(value, {
        get(namespace, method) {
          const member = Reflect.get(namespace, method, namespace);
          if (typeof member !== 'function') return member;
          if (typeof method === 'string' && CONTENT_WRITE_VERB.test(method)) {
            return () => {
              throw new MarketContentWriteForbiddenError(`${String(property)}.${method}`);
            };
          }
          return member.bind(namespace);
        },
      });
    },
  });
