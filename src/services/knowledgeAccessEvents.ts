import { isTrpcErrorCode } from '@/utils/trpcError';

type AccessObserver = () => void;
const observers = new Set<AccessObserver>();
export const subscribeKnowledgeAccessRefused = (observer: AccessObserver) => {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
};

/** Decorate each method once: method references and later spies remain stable. */
export const observeKnowledgeAccess = <T extends object>(service: T): T => {
  const wrapped = new Set<PropertyKey>();
  for (
    let source: object | null = service;
    source && source !== Object.prototype;
    source = Object.getPrototypeOf(source)
  ) {
    for (const key of Reflect.ownKeys(source)) {
      if (key === 'constructor' || wrapped.has(key)) continue;
      wrapped.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      const method = descriptor?.value;
      if (typeof method !== 'function') continue;
      Object.defineProperty(service, key, {
        configurable: true,
        enumerable: descriptor?.enumerable,
        writable: true,
        value: (...args: unknown[]) => {
          // Capture the open library at request start. A response from a view
          // that has since closed must not send the new view elsewhere.
          const active = [...observers];
          const result = Reflect.apply(method, service, args);
          if (!(result instanceof Promise)) return result;
          return result.catch((error: unknown) => {
            if (isTrpcErrorCode(error, 'NOT_FOUND') || isTrpcErrorCode(error, 'FORBIDDEN')) {
              for (const observer of active) if (observers.has(observer)) observer();
            }
            throw error;
          });
        },
      });
    }
  }
  return service;
};
