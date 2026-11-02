import { describe, expect, it } from 'vitest';

import { summarizeThreadProgress } from './summarize';

describe('summarizeThreadProgress', () => {
  it('is empty before the child has replied', () => {
    expect(
      summarizeThreadProgress([{ content: 'question', id: 'u1', role: 'user' }] as any),
    ).toEqual({});
  });

  it('shows the latest thinking while the child reasons', () => {
    expect(
      summarizeThreadProgress([
        {
          content: '',
          id: 'a1',
          reasoning: { content: '先看需求\n正在读鉴权相关文件' },
          role: 'assistant',
        },
      ] as any),
    ).toEqual({ activity: { text: '正在读鉴权相关文件', type: 'thinking' } });
  });

  it('shows the tool the child is waiting on', () => {
    expect(
      summarizeThreadProgress([
        {
          content: '',
          id: 'a1',
          role: 'assistant',
          tools: [{ apiName: 'readFile', id: 'call_1', identifier: 'local-files' }],
        },
      ] as any),
    ).toEqual({ activity: { name: 'readFile', type: 'tool' } });
  });

  it('pairs the thinking with the newest line of the answer being written', () => {
    expect(
      summarizeThreadProgress([
        {
          content: '第一段\n\n准备把密码登录收成 oauth 入口',
          id: 'a1',
          reasoning: { content: '核对 session 写入点' },
          role: 'assistant',
        },
      ] as any),
    ).toEqual({
      activity: { text: '核对 session 写入点', type: 'thinking' },
      text: '准备把密码登录收成 oauth 入口',
    });
  });

  it('keeps the earlier answer while a finished tool step hands over to a new one', () => {
    expect(
      summarizeThreadProgress([
        {
          content: '我先看下代码',
          id: 'a1',
          role: 'assistant',
          tools: [{ apiName: 'readFile', id: 'call_1', identifier: 'local-files' }],
        },
        { content: 'file body', id: 't1', role: 'tool', tool_call_id: 'call_1' },
        { content: '', id: 'a2', role: 'assistant' },
      ] as any),
    ).toEqual({ text: '我先看下代码' });
  });

  it('shows the end of a long line, where the new words are', () => {
    const line = `${'旧'.repeat(100)}最新的字`;

    const { text } = summarizeThreadProgress([
      { content: line, id: 'a1', role: 'assistant' },
    ] as any);

    expect(text?.startsWith('…')).toBe(true);
    expect(text?.endsWith('最新的字')).toBe(true);
    expect(text!.length).toBeLessThanOrEqual(81);
  });
});
