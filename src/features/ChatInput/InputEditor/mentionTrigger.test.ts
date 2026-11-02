import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards `patches/@lobehub__editor@5.0.2.patch`: Chinese text has no space
 * before `@`, and Chinese IMEs may emit a fullwidth `＠`. The matcher is not
 * exported by the package, so load the patched dist file directly.
 */
const loadMatcher = async () => {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@lobehub/editor/package.json');
  // Node's own loader: Vitest's runner cannot resolve this file by absolute path.
  const mod = require(path.join(path.dirname(pkg), 'es/plugins/slash/utils/utils.js'));
  return mod.getBasicTypeaheadTriggerMatch as (
    trigger: string,
    options: Record<string, unknown>,
  ) => (text: string) => { leadOffset: number; replaceableString: string } | null;
};

describe('@ mention trigger', () => {
  it.each([
    ['帮我@', 2, '@'],
    ['帮我@产品经理', 2, '@产品经理'],
    ['好的，@产品', 3, '@产品'],
    ['＠产品', 0, '＠产品'],
    ['你好＠', 2, '＠'],
    ['@产品', 0, '@产品'],
    ['hi @pm', 3, '@pm'],
  ])('opens for %s', async (text, leadOffset, replaceableString) => {
    const match = (await loadMatcher())('@', {})(text);
    expect(match).toMatchObject({ leadOffset, replaceableString });
  });

  it.each(['mail a@b.com', 'abc@'])('stays closed after a Latin word: %s', async (text) => {
    expect((await loadMatcher())('@', {})(text)).toBeNull();
  });

  it('keeps the slash command trigger unchanged', async () => {
    const match = await loadMatcher();
    expect(match('/', {})('和/或')).toBeNull();
    expect(match('/', {})('/cmd')).toMatchObject({ leadOffset: 0 });
  });
});
