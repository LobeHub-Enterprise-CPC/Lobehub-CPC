import type * as BusinessConstModule from '@lobechat/business-const';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getToolDisplayIdentifier } from './toolDisplay';

const brand = vi.hoisted(() => ({
  displayIdentifiers: {} as Record<string, string>,
  name: 'Acme Workspace',
  namespace: '',
}));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConstModule>()),
  get BRANDING_NAME() {
    return brand.name;
  },
  get BUILTIN_TOOL_DISPLAY_IDENTIFIERS() {
    return brand.displayIdentifiers;
  },
  get BUILTIN_TOOL_DISPLAY_NAMESPACE() {
    return brand.namespace;
  },
}));

afterEach(() => {
  brand.displayIdentifiers = {};
  brand.name = 'Acme Workspace';
  brand.namespace = '';
});

describe('getToolDisplayIdentifier', () => {
  it('shows runtime identifiers unchanged when the distribution sets no display slots', () => {
    for (const id of ['lobe-artifacts', 'lobe-cloud-sandbox', 'task', 'lobehub-custom', 'mcp-x'])
      expect(getToolDisplayIdentifier(id)).toBe(id);
  });

  it('shows the builtin LobeHub skill as the brand name', () => {
    expect(getToolDisplayIdentifier('lobehub')).toBe('acmeworkspace');

    brand.name = 'LobeHub';
    expect(getToolDisplayIdentifier('lobehub')).toBe('lobehub');
  });

  it('replaces the builtin `lobe-` prefix with the display namespace', () => {
    brand.namespace = 'acme';

    expect(getToolDisplayIdentifier('lobe-cloud-sandbox')).toBe('acme-cloud-sandbox');
    expect(getToolDisplayIdentifier('lobe-agent')).toBe('acme-agent');
    // Only the prefix: other identifiers, and `lobe` inside a name, stay as they are.
    for (const id of ['task', 'claude-code', 'lobehub-custom', 'my-lobe-tool', 'lobeX'])
      expect(getToolDisplayIdentifier(id)).not.toMatch(/^acme/);
    expect(getToolDisplayIdentifier('lobehub')).toBe('acmeworkspace');
  });

  it('lets an explicit display ID win over the namespace and the brand name', () => {
    brand.namespace = 'acme';
    brand.displayIdentifiers = { 'lobe-artifacts': 'acme-portfolio', 'lobehub': 'acme' };

    expect(getToolDisplayIdentifier('lobe-artifacts')).toBe('acme-portfolio');
    expect(getToolDisplayIdentifier('lobehub')).toBe('acme');
    expect(getToolDisplayIdentifier('lobe-task')).toBe('acme-task');
  });

  it('ignores prototype members of the display map', () => {
    for (const id of ['constructor', 'toString', '__proto__'])
      expect(getToolDisplayIdentifier(id)).toBe(id);
  });
});
