// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('preserves the CJK serializer when the application loads its own serializer first', async () => {
  const require = createRequire(import.meta.url);
  const packageName = 'mdast-util-to-markdown';
  const remarkPath = require.resolve('remark-cjk-friendly');
  const extensionPath = createRequire(remarkPath).resolve('mdast-util-to-markdown-cjk-friendly');
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'markdown-dependencies-'));
  const server = await createServer({
    cacheDir,
    logLevel: 'silent',
    optimizeDeps: { entries: [] },
    server: { hmr: false, middlewareMode: true, watch: null },
  });
  try {
    const client = server.environments.client;
    const entry = path.join(server.config.root, 'src/spa/entry.web.tsx');
    // Load the same bare import from app code before visiting the CJK extension.
    await client.pluginContainer.resolveId(packageName, entry);
    const cjk = await client.pluginContainer.resolveId(packageName, extensionPath);
    expect(cjk?.id.split('?')[0]).toBe(createRequire(extensionPath).resolve(packageName));

    // A pre-bundled remark plugin can also lose the nested importer's context.
    const remark = await client.pluginContainer.resolveId('remark-cjk-friendly', entry);
    expect(remark?.id.split('?')[0]).toBe(remarkPath);
  } finally {
    await server.close();
    await rm(cacheDir, { force: true, recursive: true });
  }
}, 20_000);
