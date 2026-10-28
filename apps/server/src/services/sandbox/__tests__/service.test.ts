import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileService } from '@/server/services/file';
import type { MarketService } from '@/server/services/market';

import type { SandboxProvider } from '../types';

describe('normalizeSandboxCommandResult', () => {
  it('preserves recreation when the command fails inside a successful response', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(
      normalizeSandboxCommandResult({
        result: { exitCode: 1, stderr: 'missing input file', stdout: '' },
        sessionExpiredAndRecreated: true,
        success: true,
      }),
    ).toEqual({
      exitCode: 1,
      output: '',
      sessionExpiredAndRecreated: true,
      stderr: 'missing input file',
      success: false,
    });
  });

  it.each([undefined, false])('does not report recreation for flag %s', async (flag) => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(
      normalizeSandboxCommandResult({
        result: { exitCode: 0, stdout: 'output' },
        sessionExpiredAndRecreated: flag,
        success: true,
      }),
    ).toEqual({ exitCode: 0, output: 'output', stderr: undefined, success: true });
  });

  it.each([true, false])('preserves recreation when transport success is %s', async (success) => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(
      normalizeSandboxCommandResult({
        error: success ? undefined : { message: 'missing file' },
        result: { exitCode: 0, stdout: 'output' },
        sessionExpiredAndRecreated: true,
        success,
      }),
    ).toMatchObject({ sessionExpiredAndRecreated: true, success });
  });

  it('keeps a real non-zero shell observation instead of collapsing it into a synthetic exit', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(
      normalizeSandboxCommandResult({
        result: { exitCode: 7, stderr: 'boom', stdout: 'partial output' },
        sessionExpiredAndRecreated: true,
        success: true,
      }),
    ).toEqual({
      exitCode: 7,
      output: 'partial output',
      sessionExpiredAndRecreated: true,
      stderr: 'boom',
      success: false,
    });
  });

  it('does not report a missing exit code as exit 0 success while the command is running', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    const result = normalizeSandboxCommandResult({
      result: { commandId: 'shell-9', output: 'partial', running: true },
      success: true,
    });

    expect(result.exitCode).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.shellId).toBe('shell-9');
    expect(result.output).toBe('partial');
  });

  it('does not invent an exit code for an observation without one', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    const result = normalizeSandboxCommandResult({
      result: { stdout: 'still going' },
      success: true,
    });

    expect(result).not.toHaveProperty('exitCode');
    expect(result.success).toBe(true);
  });
});

describe('normalizeSandboxCommandResult — failed tool call (never executed)', () => {
  it('preserves the upstream error kind instead of reporting a shell failure', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(
      normalizeSandboxCommandResult({
        error: { message: 'blocked by policy', name: 'COMMAND_GOVERNANCE_DENIED' },
        result: null,
        success: false,
      }),
    ).toEqual({
      error: { message: 'blocked by policy', name: 'COMMAND_GOVERNANCE_DENIED' },
      output: '',
      success: false,
    });
  });

  it('keeps a governance outage distinct from a policy denial and never fabricates an exit code', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    const result = normalizeSandboxCommandResult({
      error: {
        message: 'governance unavailable; temporary',
        name: 'COMMAND_GOVERNANCE_UNAVAILABLE',
      },
      result: null,
      success: false,
    });

    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('exitCode');
    expect(result.error).toMatchObject({ name: 'COMMAND_GOVERNANCE_UNAVAILABLE' });
    expect(result.error?.name).not.toBe('COMMAND_GOVERNANCE_DENIED');
  });

  it('preserves the error details and recreation even when the envelope failed', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(
      normalizeSandboxCommandResult({
        error: { code: 'COMMAND_GOVERNANCE_UNAVAILABLE', message: 'not run' },
        result: { code: 'COMMAND_GOVERNANCE_UNAVAILABLE', message: 'not run' },
        sessionExpiredAndRecreated: true,
        success: false,
      }),
    ).toEqual({
      error: { code: 'COMMAND_GOVERNANCE_UNAVAILABLE', message: 'not run' },
      output: '',
      sessionExpiredAndRecreated: true,
      success: false,
    });
  });

  it('falls back to a generic message when the upstream error is absent', async () => {
    const { normalizeSandboxCommandResult } = await import('../service');

    expect(normalizeSandboxCommandResult({ result: null, success: false })).toEqual({
      error: { message: 'Command execution failed' },
      output: '',
      success: false,
    });
  });
});

describe('SandboxMiddlewareService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uploads provider exports through the shared file record flow', async () => {
    const { SandboxMiddlewareService: TestSandboxMiddlewareService } = await import('../service');
    const exportFileToUploadUrl = vi.fn(async () => ({
      result: { mime_type: 'text/plain' },
      success: true,
    }));
    const provider = {
      capabilities: {
        backgroundCommands: true,
        exportFile: true,
        files: true,
        languages: ['python'],
        persistentSession: true,
        shell: true,
        skillScripts: true,
      },
      callTool: vi.fn(),
      exportFileToUploadUrl,
      kind: 'onlyboxes',
    } satisfies SandboxProvider;

    const fileService = {
      createPreSignedUpload: vi.fn(async () => ({
        headers: { 'x-amz-acl': 'public-read' },
        url: 'https://uploads.example.com/put',
      })),
      createFileRecord: vi.fn(async () => ({ fileId: 'file-1', url: '/f/file-1' })),
      getFileMetadata: vi.fn(async () => ({
        contentLength: 42,
        contentType: 'text/csv',
      })),
    } as unknown as FileService;

    const service = new TestSandboxMiddlewareService(provider, {
      fileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.exportAndUploadFile('/workspace/result.csv', 'result.csv');

    expect(result).toMatchObject({
      fileId: 'file-1',
      filename: 'result.csv',
      mimeType: 'text/csv',
      size: 42,
      success: true,
      url: '/f/file-1',
    });
    expect(exportFileToUploadUrl).toHaveBeenCalledWith({
      filename: 'result.csv',
      path: '/workspace/result.csv',
      uploadHeaders: { 'x-amz-acl': 'public-read' },
      uploadUrl: 'https://uploads.example.com/put',
    });
    expect(fileService.createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        fileType: 'text/csv',
        name: 'result.csv',
        size: 42,
        url: expect.stringMatching(
          /^code-interpreter-exports\/\d{4}-\d{2}-\d{2}\/topic-1\/result\.csv$/,
        ),
      }),
    );
  });

  it('keys the object on storageName while keeping filename as the display name', async () => {
    const { SandboxMiddlewareService: TestSandboxMiddlewareService } = await import('../service');
    const exportFileToUploadUrl = vi.fn(async () => ({
      result: { mime_type: 'text/csv' },
      success: true,
    }));
    const provider = {
      capabilities: {
        backgroundCommands: true,
        exportFile: true,
        files: true,
        languages: ['python'],
        persistentSession: true,
        shell: true,
        skillScripts: true,
      },
      callTool: vi.fn(),
      exportFileToUploadUrl,
      kind: 'onlyboxes',
    } satisfies SandboxProvider;

    const fileService = {
      createPreSignedUpload: vi.fn(async () => ({
        headers: {},
        url: 'https://uploads.example.com/put',
      })),
      createFileRecord: vi.fn(async () => ({ fileId: 'file-1', url: '/f/file-1' })),
      getFileMetadata: vi.fn(async () => ({ contentLength: 42, contentType: 'text/csv' })),
    } as unknown as FileService;

    const service = new TestSandboxMiddlewareService(provider, {
      fileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.exportAndUploadFile('/workspace/result.csv', 'result.csv', {
      storageName: 'deadbeefdeadbeef-result.csv',
    });

    // The returned/display name is the clean basename, never the storage key.
    expect(result.filename).toBe('result.csv');
    // The storage key (both the presigned upload key and the file record url)
    // uses storageName so the object is collision-proof.
    expect(fileService.createPreSignedUpload).toHaveBeenCalledWith(
      expect.stringMatching(
        /^code-interpreter-exports\/\d{4}-\d{2}-\d{2}\/topic-1\/deadbeefdeadbeef-result\.csv$/,
      ),
    );
    expect(fileService.createFileRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'result.csv',
        url: expect.stringMatching(/\/deadbeefdeadbeef-result\.csv$/),
      }),
    );
    // The provider still receives the display filename (unchanged contract).
    expect(exportFileToUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'result.csv', path: '/workspace/result.csv' }),
    );
  });

  it('normalizes provider export failures before storage metadata is read', async () => {
    const provider = {
      capabilities: {
        backgroundCommands: true,
        exportFile: true,
        files: true,
        languages: ['python'],
        persistentSession: true,
        shell: true,
        skillScripts: true,
      },
      callTool: vi.fn(),
      exportFileToUploadUrl: vi.fn(async () => ({
        error: { message: 'no such file', name: 'not_found' },
        success: false,
      })),
      kind: 'onlyboxes',
    } satisfies SandboxProvider;

    const { SandboxMiddlewareService } = await import('../service');
    const fileService = {
      createFileRecord: vi.fn(),
      createPreSignedUpload: vi.fn(async () => ({ url: 'https://uploads.example.com/put' })),
      getFileMetadata: vi.fn(),
    } as unknown as FileService;

    const service = new SandboxMiddlewareService(provider, {
      fileService,
      marketService: {} as MarketService,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await service.exportAndUploadFile('/workspace/missing.txt', 'missing.txt');

    expect(result).toMatchObject({
      error: { message: 'no such file', name: 'not_found' },
      filename: 'missing.txt',
      success: false,
    });
    expect(fileService.getFileMetadata).not.toHaveBeenCalled();
    expect(fileService.createFileRecord).not.toHaveBeenCalled();
  });
});
