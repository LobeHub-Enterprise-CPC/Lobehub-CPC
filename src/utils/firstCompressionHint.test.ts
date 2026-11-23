/** @vitest-environment happy-dom */
import { expect, it } from 'vitest';

import {
  dismissFirstCompression,
  rememberFirstCompression,
  isFirstCompressionVisible,
} from './firstCompressionHint';

it('only shows the first automatic group until dismissed, independently per topic', () => {
  expect(isFirstCompressionVisible('a', 'manual')).toBe(false);
  rememberFirstCompression('a', 'first');
  rememberFirstCompression('a', 'later');
  rememberFirstCompression('b', 'other');
  expect(isFirstCompressionVisible('a', 'first')).toBe(true);
  expect(isFirstCompressionVisible('a', 'later')).toBe(false);
  dismissFirstCompression('a');
  rememberFirstCompression('a', 'again');
  expect(isFirstCompressionVisible('a', 'first')).toBe(false);
  expect(isFirstCompressionVisible('a', 'again')).toBe(false);
  expect(isFirstCompressionVisible('b', 'other')).toBe(true);
});
