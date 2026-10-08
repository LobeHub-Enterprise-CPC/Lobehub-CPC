import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@lobechat/business-const');
  vi.resetModules();
});

describe('sandbox environment overrides', () => {
  it('describes the upstream environment when using the default slot', async () => {
    vi.doMock('@lobechat/business-const', () => import('../../business/const/src'));

    const { systemPrompt } = await import('./systemRole');

    expect(systemPrompt).toContain('AWS Bedrock AgentCore');
    expect(systemPrompt).toContain('lobehubbot/python-node:latest (Debian-based)');
    expect(systemPrompt).toContain('LibreOffice - Office document processing');
    expect(systemPrompt).not.toContain('There is no LibreOffice or Pandoc');
    expect(systemPrompt).not.toContain('veFaaS');
    expect(systemPrompt).not.toContain('/home/gem');
  });

  it('uses the overridden software description without appending another deployment’s restrictions', async () => {
    vi.doMock('@lobechat/business-const', () => ({
      SANDBOX_INFRASTRUCTURE: 'Custom sandbox',
      SANDBOX_PREINSTALLED_SOFTWARE: 'Custom image with pnpm and LibreOffice.',
    }));

    const { systemPrompt } = await import('./systemRole');
    const softwareSection = systemPrompt
      .split('<preinstalled_software>')[1]
      .split('</preinstalled_software>')[0];

    expect(systemPrompt).toContain('runs on Custom sandbox');
    expect(softwareSection).toContain('Custom image with pnpm and LibreOffice.');
    expect(softwareSection).not.toContain('NOT Available');
    expect(softwareSection).not.toContain('There is no LibreOffice or Pandoc');
    expect(softwareSection).not.toContain('pnpm — use npm instead');
  });
});
