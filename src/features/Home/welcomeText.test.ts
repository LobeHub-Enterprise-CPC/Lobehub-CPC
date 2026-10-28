import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async (isCustomBranding: boolean) => {
  vi.resetModules();
  vi.doMock('@/const/version', () => ({ isCustomBranding }));
  return import('./welcomeText');
};

afterEach(() => {
  vi.doUnmock('@/const/version');
});

describe('parseGreetingLine', () => {
  it('links bare #123 references to the upstream tracker on the vendor build', async () => {
    const { parseGreetingLine } = await load(false);

    const { links, plain } = parseGreetingLine('Fixed #42 today');

    expect(plain).toBe('Fixed #42 today');
    expect(links).toEqual([
      {
        end: 9,
        href: 'https://github.com/lobehub/lobehub/issues/42',
        start: 6,
        text: '#42',
      },
    ]);
  });

  it('keeps bare #123 references as text on a rebranded build', async () => {
    const { parseGreetingLine } = await load(true);

    const { links, plain } = parseGreetingLine('Fixed #42 in [the brief](/brief/1)');

    expect(plain).toBe('Fixed #42 in the brief');
    expect(links).toEqual([{ end: 22, href: '/brief/1', start: 13, text: 'the brief' }]);
  });
});
