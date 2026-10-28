// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { TenantClaims } from './claims';

describe('process-local in-flight work', () => {
  it('counts parents and bound children until actual completion, without storage writes', async () => {
    const claims = new TenantClaims();
    const release = await claims.enter('tenant');
    const child = claims.bind('tenant');
    await release();
    expect(claims.isHeld('tenant')).toBe(true);
    await child();
    await child();
    expect(claims.isHeld('tenant')).toBe(false);
  });
});
