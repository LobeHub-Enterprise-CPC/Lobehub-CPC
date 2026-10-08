import { beforeEach, describe, expect, it, vi } from 'vitest';

const SERVICE_NAMES = ['Gmail', 'Google Calendar', 'Slack', 'GitHub', 'Notion'];

const load = async (EXTERNAL_INTEGRATIONS_ENABLED: boolean) => {
  vi.resetModules();
  vi.doMock('@lobechat/business-const', () => ({
    BRANDING_NAME: 'TestBrand',
    EXTERNAL_INTEGRATIONS_ENABLED,
  }));

  const { systemPrompt } = await import('./systemRole');
  const { CredsManifest } = await import('./manifest');
  return {
    apiNames: CredsManifest.api.map((a) => a.name),
    descriptions: CredsManifest.api.map((a) => a.description).join('\n'),
    systemPrompt,
  };
};

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('@lobechat/business-const');
});

describe('EXTERNAL_INTEGRATIONS_ENABLED = true (upstream default)', () => {
  it('advertises the OAuth providers and Composio services', async () => {
    const { systemPrompt } = await load(true);

    expect(systemPrompt).toContain('<oauth_providers>');
    expect(systemPrompt).toContain('<composio_integrations>');
    expect(systemPrompt).toContain('<composio_guidelines>');
    // The runtime substitution target has to survive, or the services list
    // silently stops being injected.
    expect(systemPrompt).toContain('{{COMPOSIO_SERVICES_LIST}}');
    expect(systemPrompt).toContain('initiateOAuthConnect');
  });

  it('exposes the integration tools', async () => {
    const { apiNames } = await load(true);

    expect(apiNames).toContain('connectComposioService');
    expect(apiNames).toContain('initiateOAuthConnect');
  });
});

describe('EXTERNAL_INTEGRATIONS_ENABLED = false', () => {
  it('names no third-party service anywhere in the prompt', async () => {
    const { systemPrompt } = await load(false);

    for (const name of [...SERVICE_NAMES, 'Composio', 'composio', 'gmail', 'twitter']) {
      expect(systemPrompt, `leaked: ${name}`).not.toContain(name);
    }
  });

  it('leaves no unsubstituted placeholder behind', async () => {
    const { systemPrompt } = await load(false);

    expect(systemPrompt).not.toContain('{{INTEGRATIONS_SECTIONS}}');
    expect(systemPrompt).not.toContain('{{COMPOSIO_SECTIONS}}');
  });

  it('drops the integration tools from the manifest', async () => {
    // Prompt-only removal is not enough: tool descriptions reach the model too,
    // and both of these name the services they connect to.
    const { apiNames, descriptions } = await load(false);

    expect(apiNames).not.toContain('connectComposioService');
    expect(apiNames).not.toContain('initiateOAuthConnect');
    for (const name of SERVICE_NAMES) {
      expect(descriptions, `leaked in tool description: ${name}`).not.toContain(name);
    }
  });

  it('keeps local credential management intact', async () => {
    const { apiNames, systemPrompt } = await load(false);

    expect(apiNames).toContain('requestCredsInput');
    expect(apiNames).toContain('injectCredsToSandbox');
    expect(systemPrompt).toContain('{{CREDS_LIST}}');
    expect(systemPrompt).toContain('Never display credential values');
  });
});
