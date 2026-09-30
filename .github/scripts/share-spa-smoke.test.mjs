import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium, expect } from '@playwright/test';

// Exercise the emitted chunks, not Vite's development module graph. In particular,
// each route must render its logo BEFORE a topic body can initialize shared chunks.
const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'dist/share');
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};
let browser;
let server;
let origin;

before(async () => {
  const html = await readFile(path.join(dist, 'index.html'));
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (pathname.startsWith('/share/')) {
        response.setHeader('Content-Type', 'text/html');
        response.end(html);
        return;
      }
      const relative = pathname.replace(/^\/_spa-share\//, '');
      const file = path.resolve(dist, relative);
      if (!file.startsWith(`${dist}${path.sep}`)) throw new Error('Invalid asset path');
      response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const routes = [
  {
    path: '/share/t/startup-fixture',
    procedure: 'share.getSharedTopic',
    data: {
      agentId: 'agt_startup_fixture',
      agentMeta: { title: 'Startup fixture agent' },
      groupId: null,
      shareId: 'startup-fixture',
      title: 'Shared topic startup',
      topicId: 'tpc_startup_fixture',
      visibility: 'link',
    },
    title: 'Shared topic startup',
  },
  {
    path: '/share/page/startup-fixture',
    procedure: 'pageShare.getSharedDocument',
    data: {
      document: { id: 'docs_startup-fixture', title: 'Shared page startup' },
      isOwner: false,
      permission: 'read',
      visibility: 'link',
    },
    title: 'Shared page startup',
  },
  {
    path: '/share/artifact/startup-fixture',
    procedure: 'artifactShare.getShared',
    data: {
      iframeSrc: 'data:text/html,<h1>Shared artifact content</h1>',
      title: 'Shared artifact startup',
    },
    title: 'Shared artifact startup',
  },
];

for (const fixture of routes) {
  test(`cold production SPA: ${fixture.path}`, { timeout: 30_000 }, async () => {
    // A new context and page for EVERY route prevents a warm module cache from
    // masking missing cross-chunk initialization (the original regression).
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // React catches invalid element types in the router boundary, so pageerror
      // alone would miss the crash. Ignore resource HTTP logs, not React errors.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        errors.push(message.text());
      }
    });
    let releaseMetadata;
    const metadataGate = new Promise((resolve) => {
      releaseMetadata = resolve;
    });
    await page.route('**/trpc/lambda/**', async (route) => {
      const procedure = new URL(route.request().url()).pathname.split('/').at(-1);
      requests.push(procedure);
      let data;
      if (procedure === fixture.procedure) {
        await metadataGate;
        data = fixture.data;
      } else if (procedure === 'message.getMessagesByCursor') {
        data = {
          messages: [
            {
              id: 'msg_startup_fixture',
              role: 'user',
              content: 'Shared conversation content',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          nextCursor: null,
        };
      } else {
        errors.push(`Unexpected RPC: ${procedure}`);
        await route.abort();
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ result: { data: { json: data } } }),
      });
    });

    try {
      await page.goto(`${origin}${fixture.path}`);
      await expect(page.locator('header')).toBeVisible();
      await expect(page.locator('header').locator('img, svg').first()).toBeVisible();
      await expect.poll(() => requests).toContain(fixture.procedure);
      assert.deepEqual(errors, [], 'Initial layout must render without React or module errors');

      releaseMetadata();
      await expect(page.locator('header')).toContainText(fixture.title);
      if (fixture.procedure === 'share.getSharedTopic') {
        await expect(page.getByText('Shared conversation content', { exact: true })).toBeVisible();
      }
      if (fixture.procedure === 'artifactShare.getShared') {
        await expect(page.frameLocator('iframe').getByRole('heading')).toHaveText(
          'Shared artifact content',
        );
      }
      await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
      assert.deepEqual(errors, [], 'Loaded share must remain free of runtime errors');
    } catch (error) {
      console.error({ errors, requests });
      throw error;
    } finally {
      releaseMetadata();
      await context.close();
    }
  });
}
