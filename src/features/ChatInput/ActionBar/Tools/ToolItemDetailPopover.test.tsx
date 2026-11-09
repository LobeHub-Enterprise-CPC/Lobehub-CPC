/**
 * @vitest-environment happy-dom
 */
import {
  ArtifactsIdentifier,
  builtinSkillManifests,
  LobeHubIdentifier,
} from '@lobechat/builtin-skills/manifests';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ToolItemDetailPopover from './ToolItemDetailPopover';

const brand = vi.hoisted(() => ({
  displayIdentifiers: {} as Record<string, string>,
  name: 'Acme Workspace',
  namespace: '',
}));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
  cleanup();
  brand.displayIdentifiers = {};
  brand.name = 'Acme Workspace';
  brand.namespace = '';
});

const renderPopover = (identifier: string) =>
  render(<ToolItemDetailPopover identifier={identifier} title={'Tool'} />);

describe('ToolItemDetailPopover identifier', () => {
  it('shows the runtime identifier when the distribution sets no display slots', () => {
    renderPopover('lobe-cloud-sandbox');

    expect(screen.getByText('lobe-cloud-sandbox')).toBeTruthy();
  });

  it('shows distribution display IDs while builtin skills keep their runtime identifiers', () => {
    brand.namespace = 'acme';
    brand.displayIdentifiers = { [ArtifactsIdentifier]: 'acme-portfolio' };

    renderPopover('lobe-cloud-sandbox');
    renderPopover(ArtifactsIdentifier);
    renderPopover(LobeHubIdentifier);

    expect(screen.getByText('acme-cloud-sandbox')).toBeTruthy();
    expect(screen.getByText('acme-portfolio')).toBeTruthy();
    expect(screen.getByText('acmeworkspace')).toBeTruthy();
    expect(screen.queryByText(/^lobe/)).toBeNull();

    const runtimeIds = builtinSkillManifests.map((skill) => skill.identifier);
    expect(runtimeIds).toContain('lobe-artifacts');
    expect(runtimeIds).toContain('lobehub');
  });
});
