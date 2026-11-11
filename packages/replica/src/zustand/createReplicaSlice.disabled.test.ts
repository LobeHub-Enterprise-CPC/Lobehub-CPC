/** @vitest-environment happy-dom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { testDriver as driver } from '../../tests/testDriver';
import { defineReplica } from '../core/defineReplica';
import { createReplicaState } from '../core/reducer';
import { createReplicaSlice, recordLens } from './createReplicaSlice';
import { resetScopeState, scope, type TestState } from './testUtils';

const wrapper = ({ children }: PropsWithChildren) =>
  createElement(
    SWRConfig,
    { value: { dedupingInterval: 0, shouldRetryOnError: false, provider: () => new Map() } },
    children,
  );

beforeEach(resetScopeState);
afterEach(cleanup);

describe('useSync disabled while a request is in flight', () => {
  it.each(['null', 'undefined', 'disabled'] as const)(
    'settles a late error against its original resource after %s',
    async (mode) => {
      let reject!: (error: Error) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<string[]>((_resolve, fail) => {
            reject = fail;
          }),
      );
      const resourceError = vi.fn();
      const resource = defineReplica<{ id: string }, string[]>({
        fetcher,
        key: ({ id }) => id,
        name: `late-disabled-${mode}`,
        scope,
        storage: 'memory',
        version: 1,
      });
      const store = createStore<TestState>()(() => ({
        lists: {},
        listsReplica: createReplicaState(),
      }));
      const slice = createReplicaSlice<TestState, { id: string }, string[]>(resource, {
        driver,
        get: store.getState,
        set: (partial) => store.setState(partial),
        effects: { onError: resourceError },
        stateKey: 'listsReplica',
        view: recordLens('lists'),
      });
      const consumerError = vi.fn();
      const session = renderHook(
        ({ params, enabled }: { params: { id: string } | null | undefined; enabled: boolean }) =>
          slice.useSync(params, { enabled, onError: consumerError }),
        {
          initialProps: { params: { id: 'original' }, enabled: true },
          wrapper,
        },
      );
      await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      session.rerender({
        params: mode === 'null' ? null : mode === 'undefined' ? undefined : { id: 'original' },
        enabled: mode !== 'disabled',
      });
      const failure = new Error('NOT_FOUND');
      await act(async () => {
        reject(failure);
      });
      await waitFor(() => expect(resourceError).toHaveBeenCalledOnce());
      expect(resourceError).toHaveBeenCalledWith(
        failure,
        { id: 'original' },
        { isActive: true, key: 'original', scope: 'user-1:personal' },
      );
      expect(consumerError).not.toHaveBeenCalled();
      expect(store.getState().lists).toEqual({});
      expect(session.result.current.error).toBeUndefined();
      await waitFor(() => expect(slice.debugPendingSyncRequests()).toBe(0));
    },
  );
});

it('keeps a late success in its original cache without notifying the disabled consumer', async () => {
  let resolve!: (data: string[]) => void;
  const applied = vi.fn();
  const resource = defineReplica<{ id: string }, string[]>({
    fetcher: () =>
      new Promise((done) => {
        resolve = done;
      }),
    key: ({ id }) => id,
    name: 'disabled-success',
    scope,
    storage: 'memory',
    version: 1,
  });
  const store = createStore<TestState>()(() => ({ lists: {}, listsReplica: createReplicaState() }));
  const slice = createReplicaSlice<TestState, { id: string }, string[]>(resource, {
    driver,
    get: store.getState,
    set: (partial) => store.setState(partial),
    effects: { onApplied: applied },
    stateKey: 'listsReplica',
    view: recordLens('lists'),
  });
  const consumerSuccess = vi.fn();
  const session = renderHook(
    ({ params }: { params: { id: string } | null }) =>
      slice.useSync(params, { onSuccess: consumerSuccess }),
    {
      initialProps: { params: { id: 'original' } },
      wrapper,
    },
  );
  await waitFor(() => expect(resolve).toBeDefined());
  session.rerender({ params: null });
  await act(async () => {
    resolve(['original-data']);
  });
  await waitFor(() => expect(store.getState().lists.original).toEqual(['original-data']));
  expect(applied).toHaveBeenCalledOnce();
  expect(consumerSuccess).not.toHaveBeenCalled();
  await waitFor(() => expect(slice.debugPendingSyncRequests()).toBe(0));
});
