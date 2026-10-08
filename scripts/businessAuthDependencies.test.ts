import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Business auth dependencies', () => {
  it('uses the host Better Auth version for its exported plugin and options types', () => {
    const host = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
    );
    const businessAuth = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '../packages/business/auth/package.json'),
        'utf8',
      ),
    );

    expect(businessAuth.dependencies['better-auth']).toBe(host.dependencies['better-auth']);
  });
});
