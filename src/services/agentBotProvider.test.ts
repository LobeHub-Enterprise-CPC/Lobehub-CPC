import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentBotProviderService } from './agentBotProvider';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), query: vi.fn() }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    agentBotProvider: {
      wechatPollQrStatus: { mutate: mocks.mutate, query: mocks.query },
    },
  },
}));

describe('agentBotProviderService.wechatPollQrStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  // The QR ticket resolves to bot credentials once confirmed, so it must travel
  // in the POST body (mutation), never in a GET query string.
  it('sends the QR ticket as a mutation, not a query', async () => {
    mocks.mutate.mockResolvedValue({ status: 'wait' });

    await expect(agentBotProviderService.wechatPollQrStatus('ticket-1')).resolves.toEqual({
      status: 'wait',
    });

    expect(mocks.mutate).toHaveBeenCalledWith({ qrcode: 'ticket-1' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
