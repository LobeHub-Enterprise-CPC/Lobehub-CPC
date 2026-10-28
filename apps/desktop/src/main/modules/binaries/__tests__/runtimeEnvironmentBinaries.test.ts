import * as childProcess from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const branding = vi.hoisted(() => ({
  brandName: 'LobeHub',
  primaryBin: 'lh',
  rebranded: false,
  wrapperNames: ['lobehub', 'lh', 'lobe'],
}));

vi.mock('node:child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));

vi.mock('@/const/branding', () => ({
  get BRANDING_NAME() {
    return branding.brandName;
  },
  get CLI_PRIMARY_BIN() {
    return branding.primaryBin;
  },
  get isCustomBranding() {
    return branding.rebranded;
  },
}));

vi.mock('@/modules/cliEmbedding/generateCliWrapper', () => ({
  binNames: () => branding.wrapperNames,
}));

const { lobehubBinary } = await import('../runtimeEnvironmentBinaries');

const execMock = vi.mocked(childProcess.exec);

/** A fake shell: `which <cmd>` resolves only installed commands; each answers --help/--version. */
const installShell = (installed: Record<string, { help: string; version: string }>) => {
  execMock.mockImplementation(((command: string, opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const [bin, arg] = command.split(' ');
    const lookup = bin === 'which' || bin === 'where';
    const tool = installed[lookup ? arg : bin];
    if (!tool) callback(new Error(`not found: ${command}`), { stderr: '', stdout: '' });
    else
      callback(null, {
        stderr: '',
        stdout: lookup ? `/usr/local/bin/${arg}\n` : arg === '--help' ? tool.help : tool.version,
      });
    return {} as any;
  }) as any);
};

const UPSTREAM_CLI = {
  help: 'LobeHub CLI - manage and connect to LobeHub services',
  version: '0.0.69',
};
const BRANDED_CLI = { help: 'Acme CLI - manage and connect to Acme services', version: '1.2.3' };

describe('lobehubBinary', () => {
  beforeEach(() => {
    execMock.mockReset();
    Object.assign(branding, {
      brandName: 'LobeHub',
      primaryBin: 'lh',
      rebranded: false,
      wrapperNames: ['lobehub', 'lh', 'lobe'],
    });
  });

  it('finds the upstream CLI on the vendor build', async () => {
    installShell({ lh: UPSTREAM_CLI });

    await expect(lobehubBinary.detect()).resolves.toEqual({
      available: true,
      path: '/usr/local/bin/lh',
      version: '0.0.69',
    });
  });

  it("finds a rebranded build's own CLI under its command name", async () => {
    Object.assign(branding, {
      brandName: 'Acme',
      primaryBin: 'acme',
      rebranded: true,
      wrapperNames: ['acme'],
    });
    installShell({ acme: BRANDED_CLI, lh: UPSTREAM_CLI });

    await expect(lobehubBinary.detect()).resolves.toEqual({
      available: true,
      path: '/usr/local/bin/acme',
      version: '1.2.3',
    });
  });

  it('does not report an installed upstream CLI as a rebranded build’s own', async () => {
    Object.assign(branding, {
      brandName: 'Acme',
      primaryBin: 'acme',
      rebranded: true,
      wrapperNames: ['acme'],
    });
    installShell({ lh: UPSTREAM_CLI, lobehub: UPSTREAM_CLI });

    await expect(lobehubBinary.detect()).resolves.toEqual({ available: false });
  });
});
