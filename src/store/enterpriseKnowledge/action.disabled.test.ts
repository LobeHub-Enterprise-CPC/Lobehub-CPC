/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheScope } from '@/libs/replica';

import { enterpriseKnowledgeActions } from './action';

const api = vi.hoisted(() => ({
  resolveLevel: vi.fn(),
  getNodeAccess: vi.fn(),
  estimateNodeAccess: vi.fn(),
  getAccess: vi.fn(),
  estimateAccess: vi.fn(),
}));
vi.mock('@/services/enterpriseKnowledge', () => ({ enterpriseKnowledgeService: api }));
const wrapper = ({ children }: PropsWithChildren) =>
  createElement(
    SWRConfig,
    {
      value: { provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 },
    },
    children,
  );

beforeEach(() => {
  const scope = `disabled-enterprise-${crypto.randomUUID()}`;
  vi.spyOn(cacheScope, 'get').mockReturnValue(scope);
  vi.spyOn(cacheScope, 'use').mockReturnValue(scope);
  vi.spyOn(cacheScope, 'canPersist').mockReturnValue(false);
  enterpriseKnowledgeActions.reset();
});
afterEach(() => {
  cleanup();
  enterpriseKnowledgeActions.reset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const node = { knowledgeBaseId: 'library', nodeId: 'node' };
const estimate = { ...node, mode: 'custom' as const, grants: [] };
const cases = [
  {
    name: 'node level',
    fetcher: api.resolveLevel,
    useRead: (active: boolean) =>
      enterpriseKnowledgeActions.useFetchNodeLevel(active ? node : null),
  },
  {
    name: 'node access',
    fetcher: api.getNodeAccess,
    useRead: (active: boolean) =>
      enterpriseKnowledgeActions.useFetchNodeAccess(active ? node : null),
  },
  {
    name: 'node estimate',
    fetcher: api.estimateNodeAccess,
    useRead: (active: boolean) =>
      enterpriseKnowledgeActions.useFetchNodeEstimate(active ? estimate : null),
  },
  {
    name: 'library access',
    fetcher: api.getAccess,
    useRead: (active: boolean) =>
      enterpriseKnowledgeActions.useFetchAccess(active ? 'library' : null),
  },
  {
    name: 'library estimate',
    fetcher: api.estimateAccess,
    useRead: (active: boolean) =>
      enterpriseKnowledgeActions.useFetchEstimate(active ? estimate : null),
  },
];

describe('enterprise reads disabled before a failed request settles', () => {
  it.each(cases)(
    '$name does not leak a disabled-query error through the real app SWR driver',
    async ({ fetcher, useRead }) => {
      let reject!: (error: Error) => void;
      fetcher.mockImplementation(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      );
      const session = renderHook(({ active }) => useRead(active), {
        initialProps: { active: true },
        wrapper,
      });
      await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      session.rerender({ active: false });
      await act(async () => {
        reject(new Error('request failed after permissions changed'));
      });
      expect(session.result.current.error).toBeUndefined();
      expect(session.result.current.isValidating).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
});
