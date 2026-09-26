// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { runChannelToolAttempt } from './effects';
const mocks = vi.hoisted(() => ({ beginEffect: vi.fn(), settleEffect: vi.fn() }));
vi.mock('@/database/models/channelNative', () => ({ ChannelNativeModel: class { beginEffect=mocks.beginEffect; settleEffect=mocks.settleEffect; } }));
const ctx = { operationId: 'op', userId: 'owner', serverDB: {} } as any;
const state = { host: { channel: { runId:'run', fence:1 } } } as any;
beforeEach(() => vi.resetAllMocks());
it('keeps a delivered client tool fenced after its response is lost', async () => {
  const result = await runChannelToolAttempt(ctx, state, 'call', 1, async () => ({ success:false, content:'', executionUnknown:true, error:{type:'timeout'} }));
  expect(result.executionUnknown).toBe(true);
  expect(mocks.beginEffect).toHaveBeenCalledWith('op','op:tool:call:attempt:1','tool');
  expect(mocks.settleEffect).not.toHaveBeenCalled();
});
it('counts each actual retry and rejects a new launch after revocation', async () => {
  const execute=vi.fn().mockResolvedValue({success:false,content:'',error:{kind:'retry'}});
  await runChannelToolAttempt(ctx,state,'call',1,execute);
  mocks.beginEffect.mockRejectedValueOnce(new Error('revoked'));
  await expect(runChannelToolAttempt(ctx,state,'call',2,execute)).rejects.toThrow('revoked');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(mocks.settleEffect).toHaveBeenCalledTimes(1);
});
it('retains the effect until the real promise ends even if the caller has stopped waiting', async () => {
  let finish!: (result:any)=>void;
  const work = runChannelToolAttempt(ctx,state,'call',1, () => new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve(); expect(mocks.settleEffect).not.toHaveBeenCalled();
  finish({success:true,content:'late'}); await work;
  expect(mocks.settleEffect).toHaveBeenCalledWith('op:tool:call:attempt:1');
});
