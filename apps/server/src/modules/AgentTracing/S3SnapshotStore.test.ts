// @vitest-environment node
import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

import type { ExecutionSnapshot } from '@lobechat/agent-tracing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepOwnershipLostError } from '@/server/services/agentRuntime/AgentRuntimeService/executionErrors';
import { OperationTraceRecorder } from '@/server/services/agentRuntime/OperationTraceRecorder';

const compressZstd = promisify(zstdCompress);
const decompressZstd = promisify(zstdDecompress);

// Stub FileS3 with vi.fn methods so we can assert calls + return canned data.
const uploadBuffer = vi.fn();
const getFileByteArray = vi.fn();
const getFileContent = vi.fn();
const deleteFile = vi.fn();

vi.mock('@/server/modules/S3', () => ({
  FileS3: vi.fn(function () {
    return {
      deleteFile,
      getFileByteArray,
      getFileContent,
      uploadBuffer,
    };
  }),
}));

// Imported after the mock so the constructor pulls in the stub.
const { S3SnapshotStore } = await import('./S3SnapshotStore');

const sampleSnapshot = (overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot =>
  ({
    agentId: 'agt_abc',
    completedAt: 1_777_000_000_500,
    operationId: 'op_1777000000000_agt_abc_tpc_xyz_QwErTy',
    startedAt: 1_777_000_000_000,
    steps: [],
    topicId: 'tpc_xyz',
    totalCost: 0,
    totalSteps: 0,
    totalTokens: 0,
    ...overrides,
  }) as unknown as ExecutionSnapshot;

/** What the AWS SDK throws for a GET of an object that does not exist. */
const noSuchKey = () =>
  Object.assign(new Error('The specified key does not exist.'), {
    $metadata: { httpStatusCode: 404 },
    name: 'NoSuchKey',
  });
const transient = () =>
  Object.assign(new Error('socket hang up'), { $metadata: {}, name: 'TimeoutError' });

beforeEach(() => {
  uploadBuffer.mockReset().mockResolvedValue(undefined);
  getFileByteArray.mockReset();
  getFileContent.mockReset();
  deleteFile.mockReset().mockResolvedValue(undefined);
});

describe('S3SnapshotStore.save', () => {
  it('does not start a stale canonical PUT after ownership is lost during encoding', async () => {
    const old = new S3SnapshotStore();
    const originalEncode = (old as any).encodeSnapshot.bind(old);
    let entered!: () => void, release!: () => void;
    const encoding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(old as any, 'encodeSnapshot').mockImplementationOnce(async (snapshot) => {
      entered();
      await gate;
      return originalEncode(snapshot);
    });
    let owned = true;
    const lost = new StepOwnershipLostError('op-trace', 1);
    const saving = old.save(
      sampleSnapshot({ completionReason: 'waiting_for_async_tool' } as any),
      async () => {
        if (!owned) throw lost;
      },
    );
    await encoding;
    owned = false;
    await new S3SnapshotStore().save(sampleSnapshot({ completionReason: 'done' } as any));
    const rejected = expect(saving).rejects.toBe(lost);
    release();
    await rejected;
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse((await decompressZstd(uploadBuffer.mock.calls[0][1])).toString());
    expect(snapshot.completionReason).toBe('done');
  });

  it('refuses the final PUT when ownership is lost during encoding and keeps the partial', async () => {
    const store = new S3SnapshotStore();
    const snap = sampleSnapshot();
    const lost = new StepOwnershipLostError(snap.operationId, 1);
    let owned = true;
    vi.spyOn(store, 'loadPartial').mockResolvedValue({ steps: [] });
    vi.spyOn(store as any, 'encodeSnapshot').mockImplementation(async () => {
      await Promise.resolve();
      owned = false;
      return Buffer.from('encoded');
    });
    const recorder = new OperationTraceRecorder(store);

    await expect(
      recorder.finalize(snap.operationId, {
        assertOwnership: async () => {
          if (!owned) throw lost;
        },
        completionReason: 'done',
        state: {},
      }),
    ).rejects.toBe(lost);
    expect(uploadBuffer).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('writes to agent-traces/{agentId}/{topicId}/{operationId}.json.zst with zstd body', async () => {
    const store = new S3SnapshotStore();
    const snap = sampleSnapshot();

    await store.save(snap);

    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = uploadBuffer.mock.calls[0];
    expect(key).toBe(`agent-traces/${snap.agentId}/${snap.topicId}/${snap.operationId}.json.zst`);
    expect(contentType).toBe('application/zstd');
    expect(Buffer.isBuffer(body)).toBe(true);

    // zstd frame magic: 0x28 b5 2f fd
    expect([body[0], body[1], body[2], body[3]]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);

    const roundtripped = JSON.parse((await decompressZstd(body)).toString('utf8'));
    expect(roundtripped).toEqual(snap);
  });

  it('recovers agentId/topicId from the operationId when the snapshot omits them', async () => {
    const store = new S3SnapshotStore();
    // agentId/topicId missing on the snapshot, but encoded in the operationId —
    // the key must match what readers rebuild from the operationId, not "unknown".
    await store.save(sampleSnapshot({ agentId: undefined, topicId: undefined }));

    const [key] = uploadBuffer.mock.calls[0];
    expect(key).toBe(
      'agent-traces/agt_abc/tpc_xyz/op_1777000000000_agt_abc_tpc_xyz_QwErTy.json.zst',
    );
  });

  it('falls back to "unknown" only when the operationId carries no agt_/tpc_ segments', async () => {
    const store = new S3SnapshotStore();
    await store.save(
      sampleSnapshot({
        agentId: undefined,
        operationId: 'op_legacy_no_segments',
        topicId: undefined,
      }),
    );

    const [key] = uploadBuffer.mock.calls[0];
    expect(key).toBe('agent-traces/unknown/unknown/op_legacy_no_segments.json.zst');
  });
});

describe('S3SnapshotStore.savePartial', () => {
  it('writes to agent-traces/_partial/{operationId}.json.zst with compressed body', async () => {
    const store = new S3SnapshotStore();
    const partial = { operationId: 'op_partial_1', steps: [{ stepIndex: 0 }] };

    await store.savePartial('op_partial_1', partial as Partial<ExecutionSnapshot>);

    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = uploadBuffer.mock.calls[0];
    expect(key).toBe('agent-traces/_partial/op_partial_1.json.zst');
    expect(contentType).toBe('application/zstd');

    const roundtripped = JSON.parse((await decompressZstd(body)).toString('utf8'));
    expect(roundtripped).toEqual(partial);
  });

  it('returns the stored token and fences the next write on it', async () => {
    uploadBuffer.mockResolvedValueOnce({ ETag: '"abc"' });
    const store = new S3SnapshotStore();

    const result = await store.savePartial('op_partial_2', {} as Partial<ExecutionSnapshot>);
    expect(result).toEqual({ token: '"abc"' });

    await store.savePartial('op_partial_2', {} as Partial<ExecutionSnapshot>, {
      expected: '"abc"',
    });
    expect(uploadBuffer.mock.calls[1][4]).toMatchObject({ ifMatch: '"abc"' });
  });

  it('reports a refused conditional write instead of throwing', async () => {
    uploadBuffer.mockRejectedValueOnce(
      Object.assign(new Error('precondition failed'), { $metadata: { httpStatusCode: 412 } }),
    );
    const store = new S3SnapshotStore();

    await expect(
      store.savePartial('op_partial_3', {} as Partial<ExecutionSnapshot>, { expected: '"old"' }),
    ).resolves.toEqual({ conflict: true });
  });

  it('still throws when the write fails for another reason', async () => {
    uploadBuffer.mockRejectedValueOnce(new Error('network down'));
    const store = new S3SnapshotStore();

    await expect(
      store.savePartial('op_partial_4', {} as Partial<ExecutionSnapshot>, { expected: '"old"' }),
    ).rejects.toThrow('network down');
  });
});

describe('S3SnapshotStore.loadPartial', () => {
  it('decodes the zstd-compressed .json.zst object when present', async () => {
    const partial = { operationId: 'op_load_1', steps: [{ stepIndex: 7 }] };
    const compressed = await compressZstd(Buffer.from(JSON.stringify(partial)));
    getFileByteArray.mockResolvedValueOnce(new Uint8Array(compressed));

    const store = new S3SnapshotStore();
    const result = await store.loadPartial('op_load_1');

    expect(getFileByteArray).toHaveBeenCalledWith('agent-traces/_partial/op_load_1.json.zst');
    expect(result).toEqual(partial);
  });

  it('falls back to legacy uncompressed .json when .json.zst is missing', async () => {
    const partial = { operationId: 'op_legacy_1' };
    getFileByteArray.mockRejectedValueOnce(noSuchKey());
    getFileContent.mockResolvedValueOnce(JSON.stringify(partial));

    const store = new S3SnapshotStore();
    const result = await store.loadPartial('op_legacy_1');

    expect(getFileByteArray).toHaveBeenCalledWith('agent-traces/_partial/op_legacy_1.json.zst');
    expect(getFileContent).toHaveBeenCalledWith('agent-traces/_partial/op_legacy_1.json');
    expect(result).toEqual(partial);
  });

  it('returns null when neither key exists', async () => {
    getFileByteArray.mockRejectedValueOnce(noSuchKey());
    getFileContent.mockRejectedValueOnce(noSuchKey());

    const store = new S3SnapshotStore();
    expect(await store.loadPartial('op_missing')).toBeNull();
  });

  it('reads a bare 404 from an S3-compatible store as missing too', async () => {
    const notFound = Object.assign(new Error('UnknownError'), {
      $metadata: { httpStatusCode: 404 },
      name: 'NotFound',
    });
    getFileByteArray.mockRejectedValueOnce(notFound);
    getFileContent.mockRejectedValueOnce(notFound);

    expect(await new S3SnapshotStore().loadPartial('op_missing_404')).toBeNull();
  });

  // A failed read is not a missing partial: reading it as one lets the recorder
  // start over and overwrite the steps already recorded.
  it.each([
    ['the current object', () => getFileByteArray.mockRejectedValueOnce(transient())],
    [
      'the legacy object',
      () => {
        getFileByteArray.mockRejectedValueOnce(noSuchKey());
        getFileContent.mockRejectedValueOnce(transient());
      },
    ],
  ])('rethrows a failed read of %s', async (_label, arrange) => {
    arrange();

    await expect(new S3SnapshotStore().loadPartial('op_flaky')).rejects.toThrow('socket hang up');
  });

  it('keeps the recorded trajectory when the partial read fails transiently', async () => {
    getFileByteArray.mockRejectedValueOnce(transient());
    const recorder = new OperationTraceRecorder(new S3SnapshotStore());

    await recorder.appendStep('op_parked', {
      afterStepSignalEvents: [],
      agentState: { messages: [] },
      beforeStepSignalEvents: [],
      externalRetryCount: 0,
      presentation: { executionTimeMs: 1, stepType: 'call_llm', thinking: false } as any,
      startedAt: 0,
      stepIndex: 4,
      stepResult: { events: [], newState: { messages: [] } },
    });
    await recorder.flushPartial();

    expect(uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('S3SnapshotStore.removePartial', () => {
  it('deletes both the .json.zst and legacy .json keys', async () => {
    const store = new S3SnapshotStore();
    await store.removePartial('op_remove_1');

    const keys = deleteFile.mock.calls.map(([k]) => k);
    expect(keys).toContain('agent-traces/_partial/op_remove_1.json.zst');
    expect(keys).toContain('agent-traces/_partial/op_remove_1.json');
    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it('does not throw when one delete fails (allSettled)', async () => {
    deleteFile.mockRejectedValueOnce(new Error('NoSuchKey')).mockResolvedValueOnce(undefined);

    const store = new S3SnapshotStore();
    await expect(store.removePartial('op_partial_err')).resolves.toBeUndefined();
  });
});

describe('S3SnapshotStore query stubs', () => {
  it('returns null/[] for unsupported query methods (OTEL backend owns querying)', async () => {
    const store = new S3SnapshotStore();
    expect(await store.get('any')).toBeNull();
    expect(await store.getLatest()).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.listPartials()).toEqual([]);
  });
});
