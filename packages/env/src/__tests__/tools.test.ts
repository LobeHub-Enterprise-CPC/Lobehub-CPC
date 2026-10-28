// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const multimodalEnvKeys = [
  'MULTIMODAL_UNDERSTANDING_IMAGE_FORMATS',
  'MULTIMODAL_UNDERSTANDING_MODEL',
  'MULTIMODAL_UNDERSTANDING_PROVIDER',
];

describe('getToolsConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of multimodalEnvKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of multimodalEnvKeys) delete process.env[key];
  });

  it('should use safe default image formats for multimodal understanding', async () => {
    const { getToolsConfig } = await import('../tools');
    const config = getToolsConfig();

    expect(config.MULTIMODAL_UNDERSTANDING_IMAGE_FORMATS).toEqual(['image/jpeg', 'image/png']);
  });

  it('should normalize configured multimodal image formats', async () => {
    process.env.MULTIMODAL_UNDERSTANDING_IMAGE_FORMATS = ' png, image/jpeg, jpg, image/webp, PNG ';

    const { getToolsConfig } = await import('../tools');
    const config = getToolsConfig();

    expect(config.MULTIMODAL_UNDERSTANDING_IMAGE_FORMATS).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
  });
});
