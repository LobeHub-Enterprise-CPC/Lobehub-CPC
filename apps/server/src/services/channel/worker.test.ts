// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { ChannelWorker } from './worker';

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('./native/host', () => ({ startChannelNative: start, reconcileChannelNative: vi.fn() }));
vi.mock('./native/capabilities', () => ({ loadChannelNativeCapabilities: vi.fn() }));
vi.mock('./serverDefault', () => ({ settleChannelServerDefaultOperation: vi.fn() }));
it('tracks only startup and leaves the durable operation to the standard scheduler', async () => {
  let finish!: () => void;
  start.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const worker = new ChannelWorker({} as any);
  const run = { id: 'run' } as any;
  const pending = worker['startNative']('owner', run);
  expect(worker['active'].has('run')).toBe(true);
  finish();
  await pending;
  expect(worker['active'].has('run')).toBe(false);
  expect(start).toHaveBeenCalledWith({ db: {}, ownerId: 'owner', run });
});
