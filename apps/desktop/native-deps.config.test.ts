import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getAsarUnpackPatterns } from './native-deps.config.mjs';

const macNotificationsPackage = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../packages/electron-mac-notifications/package.json',
    ),
    'utf8',
  ),
) as { scripts?: Record<string, string> };

describe('first-party native addon install scripts', () => {
  it('overrides implicit node-gyp rebuild for the darwin-only notifications addon', () => {
    expect(macNotificationsPackage.scripts?.install).toBe('node scripts/build-native.mjs');
  });
});

describe('Windows native runtime layout', () => {
  it.each([
    'node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe',
    'node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/conpty.dll',
    'node_modules/get-windows/lib/binding/napi-9-win32-unknown-x64/node-get-windows.node',
  ])('keeps %s outside ASAR for the OS loader', (file) => {
    expect(getAsarUnpackPatterns().some((pattern: string) => path.matchesGlob(file, pattern))).toBe(
      true,
    );
  });
});
