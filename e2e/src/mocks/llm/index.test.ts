import { runInNewContext } from 'node:vm';

import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import type { EventSourceMessage } from '../../../../packages/utils/src/client/fetchEventSource/parse';
import {
  getLines,
  getMessages,
} from '../../../../packages/utils/src/client/fetchEventSource/parse';
import { buildSSEChunks, LLMMockManager, presetResponses } from '.';

const parseEventStream = (stream: string): EventSourceMessage[] => {
  const messages: EventSourceMessage[] = [];
  const onChunk = getLines(
    getMessages(
      () => {},
      (message) => messages.push(message),
    ),
  );
  const bytes = new TextEncoder().encode(stream);

  // Exercise the parser across arbitrary network boundaries instead of passing
  // the entire response as one buffer.
  for (let offset = 0; offset < bytes.length; offset += 7) {
    onChunk(bytes.subarray(offset, offset + 7));
  }

  return messages;
};

const parseTextPayload = (data: string): string => {
  const payload: unknown = JSON.parse(data);

  expect(typeof payload).toBe('string');

  return payload as string;
};

const expectTextRoundTrip = (content: string, chunkSize: number) => {
  const messages = parseEventStream(buildSSEChunks(content, chunkSize).join(''));

  for (const message of messages) {
    expect(message.event).not.toBe('');
    expect(() => JSON.parse(message.data)).not.toThrow();
  }

  const text = messages
    .filter((message) => message.event === 'text')
    .map((message) => parseTextPayload(message.data))
    .join('');

  expect(text).toBe(content);
};

describe('buildSSEChunks', () => {
  it.each([1, 3, 8, 10, 64])('round-trips JSON-sensitive text with chunk size %i', (chunkSize) => {
    expectTextRoundTrip('第一行\n第二行\r\n"quoted" \\ path 😀', chunkSize);
  });

  it('round-trips the multiline scroll fixture consumed by agent E2E tests', () => {
    expectTextRoundTrip(presetResponses.longScrollArticle, 10);
  });
});

describe('tenant chat interception', () => {
  it('streams tenant chat in the browser and leaves unrelated requests alone', async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response('upstream'));
    const browserWindow: Record<string, unknown> = {
      clearTimeout,
      fetch: originalFetch,
      location: { href: 'https://app.test/t/e2e/agent/inbox' },
      setTimeout,
    };
    const page = {
      addInitScript: async ({ content }: { content: string }) => {
        runInNewContext(content, {
          DOMException,
          ReadableStream,
          Request,
          Response,
          TextEncoder,
          URL,
          window: browserWindow,
        });
      },
      exposeFunction: async (name: string, callback: unknown) => {
        browserWindow[name] = callback;
      },
    } as unknown as Page;
    await new LLMMockManager({
      defaultResponse: 'tenant reply',
      responseDelay: 0,
      streamDelay: 0,
    }).setup(page);
    const fetch = browserWindow.fetch as typeof globalThis.fetch;
    const response = await fetch('/t/e2e/webapi/chat/openai', {
      body: JSON.stringify({ messages: [] }),
      method: 'POST',
    });
    const text = parseEventStream(await response.text())
      .filter((event) => event.event === 'text')
      .map((event) => parseTextPayload(event.data))
      .join('');
    expect(text).toBe('tenant reply');
    expect(originalFetch).not.toHaveBeenCalled();
    await fetch('/t/e2e/api/config');
    expect(originalFetch).toHaveBeenCalledOnce();
  });
});
