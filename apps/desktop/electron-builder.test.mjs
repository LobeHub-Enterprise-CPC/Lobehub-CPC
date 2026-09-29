import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('node:module', () => ({
  createRequire: vi.fn(() => ({ resolve: vi.fn((id) => `/deps/${id}`) })),
}));
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify({ version: '0.9.20', shellAbi: 'abi' })),
    mkdir: vi.fn(),
    rm: vi.fn(),
    copyFile: vi.fn(),
    chmod: vi.fn(),
  },
}));
vi.mock('./native-deps.config.mjs', () => ({
  buildFirstPartyNativeAddons: vi.fn(),
  copyNativeModulesToSource: vi.fn(),
  getAsarUnpackPatterns: () => [],
  getNativeModulesFilesConfig: () => [],
}));
vi.mock('./module-deps.config.mjs', () => ({ getModuleFilesConfig: () => [] }));
vi.mock('./external-runtime-deps.config.mjs', () => ({
  copyExternalRuntimeModulesToSource: vi.fn(),
}));
vi.mock('./scripts/packBuiltinCore.mjs', () => ({ packBuiltinCore: vi.fn() }));

const { default: config } = await import('./electron-builder.mjs');

describe('packaged AUV target', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['win32', 1, 'cli-win32-x64-msvc/bin/auv.exe', 'auv.exe', 'auv'],
    ['darwin', 3, 'cli-darwin-arm64/bin/auv', 'auv', 'auv.exe'],
  ])(
    'stages %s rather than the host and removes the previous target',
    async (platform, arch, source, executable, stale) => {
      await config.beforePack({ arch, electronPlatformName: platform });
      const resolver = createRequire.mock.results[0].value.resolve;
      expect(resolver).toHaveBeenCalledWith(`@auv-js/${source}`);
      expect(fs.copyFile).toHaveBeenCalledWith(
        `/deps/@auv-js/${source}`,
        expect.stringContaining(`/resources/bin/${executable}`),
      );
      expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining(`/resources/bin/${stale}`), {
        force: true,
      });
      expect(fs.chmod).toHaveBeenCalledTimes(platform === 'win32' ? 0 : 1);
    },
  );
});
