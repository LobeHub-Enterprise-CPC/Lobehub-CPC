import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useAttachments } from './useAttachments';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('@/store/file', () => ({
  useFileStore: (select: any) => select({ uploadWithProgress: upload }),
}));
vi.mock('@lobechat/utils/compressImage', () => ({
  COMPRESSIBLE_IMAGE_TYPES: new Set(),
  compressImageFile: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@lobehub/ui/base-ui', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => {
  upload.mockReset();
});
const file = (name: string) => new File(['contents'], name, { type: 'text/plain' });

it('isolates composers and preserves picker order when same-named uploads finish out of order', async () => {
  const resolvers: ((result: { id: string; url: string }) => void)[] = [];
  upload.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
  const main = renderHook(() => useAttachments(vi.fn()));
  const thread = renderHook(() => useAttachments(vi.fn()));
  let pending: Promise<void>;
  act(() => {
    pending = main.result.current.upload([file('same.txt'), file('same.txt')]);
  });
  expect(main.result.current.readyFileIds()).toBeUndefined();
  expect(thread.result.current.items).toEqual([]);
  await act(async () => resolvers[1]({ id: 'second', url: '/second' }));
  expect(main.result.current.blocked).toBe(true);
  await act(async () => {
    resolvers[0]({ id: 'first', url: '/first' });
    await pending;
  });
  expect(main.result.current.readyFileIds()).toEqual(['first', 'second']);
  expect(new Set(upload.mock.calls.map(([arg]) => arg.uploadId)).size).toBe(2);
});

it('blocks failed uploads until retried or removed, retaining the other attachments', async () => {
  upload
    .mockResolvedValueOnce({ id: 'ok', url: '/ok' })
    .mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useAttachments(vi.fn()));
  await act(() => result.current.upload([file('a.txt'), file('b.txt')]));
  expect(result.current.readyFileIds()).toBeUndefined();
  const failed = result.current.items[1];
  expect(failed.status).toBe('error');
  upload.mockResolvedValueOnce({ id: 'retry', url: '/retry' });
  act(() => result.current.retry(failed.id));
  await waitFor(() => expect(result.current.readyFileIds()).toEqual(['ok', 'retry']));
  act(() => result.current.remove(failed.id));
  expect(result.current.readyFileIds()).toEqual(['ok']);
});

it('aborts removed and unmounted uploads without resurrecting their drafts', async () => {
  let finish!: (value: { id: string; url: string }) => void;
  upload.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => useAttachments(vi.fn()));
  let pending: Promise<void>;
  act(() => {
    pending = result.current.upload([file('a.txt')]);
  });
  const controller = upload.mock.calls[0][0].abortController;
  act(() => result.current.remove(result.current.items[0].id));
  expect(controller.signal.aborted).toBe(true);
  await act(async () => {
    finish({ id: 'late', url: '/late' });
    await pending;
  });
  expect(result.current.items).toEqual([]);
  act(() => {
    void result.current.upload([file('b.txt')]);
  });
  const next = upload.mock.calls[1][0].abortController;
  unmount();
  expect(next.signal.aborted).toBe(true);
});
