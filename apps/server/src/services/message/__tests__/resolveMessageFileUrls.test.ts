import type { UIChatMessage } from '@lobechat/types';
import { expect, it } from 'vitest';

import { resolveMessageFileUrls } from '../resolveMessageFileUrls';

it('bounds URL resolution across messages and nested groups without changing the input', async () => {
  const attachment = (id: string) => ({ alt: id, id, url: `raw/${id}` });
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`,
    role: 'user',
    imageList: [attachment(`image-${index}`)],
    members: [
      {
        id: `member-${index}`,
        role: 'user',
        audioList: [attachment(`audio-${index}`)],
      },
    ],
  })) as UIChatMessage[];
  const original = structuredClone(messages);
  let active = 0;
  let peak = 0;
  const resolved = await resolveMessageFileUrls(messages, async (file) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active -= 1;
    return `resolved/${file.id}`;
  });

  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(10);
  expect(messages).toEqual(original);
  expect(resolved.map((message) => message.id)).toEqual(messages.map((message) => message.id));
  for (const [index, message] of resolved.entries()) {
    expect(message.imageList![0].url).toBe(`resolved/image-${index}`);
    expect(message.members![0].audioList![0].url).toBe(`resolved/audio-${index}`);
  }
});

it('resolves task and council attachments together with the parent in a single browser batch', async () => {
  const { resolveMessageFileUrlsInBatch } = await import('../resolveMessageFileUrls');
  const attachment = (id: string) => ({ id, alt: id, url: `raw/${id}` });
  const messages = [
    {
      id: 'parent',
      role: 'assistant',
      imageList: [attachment('parent-file')],
      tasks: [{ id: 'task', role: 'user', imageList: [attachment('task-file')] }],
      children: [
        {
          id: 'block',
          imageList: [attachment('block-file')],
          type: 'council',
          council: [{ id: 'council', role: 'user', imageList: [attachment('council-file')] }],
        },
      ],
    },
  ] as unknown as UIChatMessage[];
  const original = structuredClone(messages);
  let calls = 0;
  const result = await resolveMessageFileUrlsInBatch(messages, async (files) => {
    calls += 1;
    return files.map((file) => `proxy/${file.id}`);
  });
  expect(calls).toBe(1);
  expect(result[0].imageList![0].url).toBe('proxy/parent-file');
  expect(result[0].tasks![0].imageList![0].url).toBe('proxy/task-file');
  expect(result[0].children![0].council![0].imageList![0].url).toBe('proxy/council-file');
  expect(result[0].children![0].imageList![0].url).toBe('proxy/block-file');
  expect(messages).toEqual(original);
});

it('includes council attachments inside CPC task completion blocks in the same batch', async () => {
  const { resolveMessageFileUrlsInBatch } = await import('../resolveMessageFileUrls');
  const messages = [
    {
      id: 'parent',
      role: 'assistant',
      taskCompletions: [
        {
          id: 'completion',
          imageList: [{ id: 'completion-file', alt: 'image', url: 'raw/completion-file' }],
          council: [
            {
              id: 'council',
              role: 'user',
              imageList: [{ id: 'file', alt: 'image', url: 'raw/file' }],
            },
          ],
        },
      ],
    },
  ] as unknown as UIChatMessage[];
  const original = structuredClone(messages);
  let calls = 0;
  const resolved = await resolveMessageFileUrlsInBatch(messages, async (files) => {
    calls += 1;
    return files.map((file) => `proxy/${file.id}`);
  });
  expect(calls).toBe(1);
  expect(resolved[0].taskCompletions![0].council![0].imageList![0].url).toBe('proxy/file');
  expect(resolved[0].taskCompletions![0].imageList![0].url).toBe('proxy/completion-file');
  expect(messages).toEqual(original);
});
