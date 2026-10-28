import { COMPUTER_USE_IDENTIFIER } from '@lobechat/device-control/computer-use';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('@/modules/cliEmbedding', () => ({ resolveCliScript: () => '/cli.js' }));

const { desktopSupportedTools } = await import('../gatewaySystemInfo');

describe('desktopSupportedTools', () => {
  it('offers computer use when the macOS package ships its helper', () => {
    expect(desktopSupportedTools('darwin', true)).toEqual([COMPUTER_USE_IDENTIFIER]);
  });

  it('withholds it on macOS when the package was built without the helper', () => {
    expect(desktopSupportedTools('darwin', false)).toEqual([]);
  });

  it('is unaffected on other platforms, which do not use the helper', () => {
    expect(desktopSupportedTools('win32', false)).toEqual([COMPUTER_USE_IDENTIFIER]);
    expect(desktopSupportedTools('linux', false)).toEqual([COMPUTER_USE_IDENTIFIER]);
  });
});
