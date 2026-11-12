/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadFile } from './downloadFile';

describe('downloadFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the session to same-origin file links so authorized downloads succeed', async () => {
    const fetchMock = vi.fn(async () => new Response('bytes'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await downloadFile('/f/file_1?download=1', 'manual.md');

    // `same-origin` attaches cookies only to the app's own origin; cross-origin
    // storage URLs (and redirects to them) stay credential-free for CORS.
    expect(fetchMock).toHaveBeenCalledWith(
      '/f/file_1?download=1',
      expect.objectContaining({ credentials: 'same-origin', mode: 'cors' }),
    );
    expect(open).not.toHaveBeenCalled();
  });
});
