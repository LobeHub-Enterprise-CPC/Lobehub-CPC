import { describe, expect, it, vi } from 'vitest';

import { CredsExecutionRuntime, type ICredsService } from './index';

const service = () =>
  ({
    getOAuthAuthorizeUrl: vi
      .fn()
      .mockResolvedValue({ authorizeUrl: 'https://market.example/auth' }),
    getOAuthConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
  }) as unknown as ICredsService & {
    getOAuthAuthorizeUrl: ReturnType<typeof vi.fn>;
  };

describe('CredsExecutionRuntime.initiateOAuthConnect', () => {
  it('returns to the callback page on the tenant app address it was given', async () => {
    const creds = service();
    const runtime = new CredsExecutionRuntime(creds, {
      appUrl: 'https://host.example/t/acme/',
    });

    const result = await runtime.initiateOAuthConnect({ provider: 'linear' });

    expect(result.success).toBe(true);
    expect(creds.getOAuthAuthorizeUrl).toHaveBeenCalledWith(
      'linear',
      'https://host.example/t/acme/oauth/callback/success?provider=linear',
    );
  });
});
