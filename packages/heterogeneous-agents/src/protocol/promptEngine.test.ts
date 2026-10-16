import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHeteroExecStdinPayload } from './execStdinPayload';
import { lobeHubCliGuide } from './lobeHubCliGuide';
import { buildHeterogeneousPrompt, HeterogeneousPromptEngine } from './promptEngine';

const businessConst = vi.hoisted(() => ({ HETEROGENEOUS_AGENT_CLI_GUIDE_ENABLED: true }));

vi.mock('@lobechat/business-const/heterogeneousAgent', () => businessConst);

describe('HeterogeneousPromptEngine', () => {
  beforeEach(() => {
    businessConst.HETEROGENEOUS_AGENT_CLI_GUIDE_ENABLED = true;
  });

  it.each([true, false])(
    'omits the CLI guide when the distribution disables it (isNewSession=%s)',
    (isNewSession) => {
      businessConst.HETEROGENEOUS_AGENT_CLI_GUIDE_ENABLED = false;

      expect(
        buildHeterogeneousPrompt({
          imageList: [{ id: 'image-1', url: 'https://example.com/image.png' }],
          isNewSession,
          prompt: 'Draft a doc',
          systemContext: 'Workspace context',
        }),
      ).toEqual([
        { text: 'Workspace context', type: 'text' },
        { text: 'Draft a doc', type: 'text' },
        {
          source: { id: 'image-1', type: 'url', url: 'https://example.com/image.png' },
          type: 'image',
        },
      ]);
    },
  );

  it('keeps the CLI guide disabled when native resume falls back to a new session', () => {
    businessConst.HETEROGENEOUS_AGENT_CLI_GUIDE_ENABLED = false;

    const payload = JSON.parse(
      buildHeteroExecStdinPayload({
        isNewSession: false,
        prompt: 'Continue',
        resumeFallbackSystemContext: 'Replayed history',
        systemContext: 'Workspace context',
      }),
    );

    expect(payload).toEqual({
      content: [
        { text: 'Workspace context', type: 'text' },
        { text: 'Continue', type: 'text' },
      ],
      resumeFallback: [
        { text: 'Replayed history', type: 'text' },
        { text: 'Continue', type: 'text' },
      ],
    });
  });

  it('orders system context, provider context, user prompt, and images', () => {
    expect(
      buildHeterogeneousPrompt({
        imageList: [{ id: 'image-1', url: 'https://example.com/image.png' }],
        prompt: '<refer_topic name="Previous" id="topic-ref" />\nSummarize it',
        systemContext: 'Workspace context',
      }),
    ).toEqual([
      { text: 'Workspace context', type: 'text' },
      {
        text: expect.stringContaining('`lh topic view <topic-id>`'),
        type: 'text',
      },
      {
        text: '<refer_topic name="Previous" id="topic-ref" />\nSummarize it',
        type: 'text',
      },
      {
        source: { id: 'image-1', type: 'url', url: 'https://example.com/image.png' },
        type: 'image',
      },
    ]);
  });

  it('does not add topic guidance to unrelated prompts', () => {
    expect(new HeterogeneousPromptEngine({ prompt: 'Hello' }).process()).toEqual([
      { text: 'Hello', type: 'text' },
    ]);
  });

  it('introduces the LobeHub CLI once, when the session is new', () => {
    const blocks = buildHeterogeneousPrompt({
      isNewSession: true,
      prompt: 'Draft a doc',
      systemContext: 'Workspace context',
    });

    expect(blocks).toEqual([
      { text: 'Workspace context', type: 'text' },
      { text: lobeHubCliGuide, type: 'text' },
      { text: 'Draft a doc', type: 'text' },
    ]);
  });

  it('omits the LobeHub CLI introduction on a resumed session', () => {
    expect(buildHeterogeneousPrompt({ isNewSession: false, prompt: 'Draft a doc' })).toEqual([
      { text: 'Draft a doc', type: 'text' },
    ]);
  });

  it('tells a new session both how to reach the platform and how to read a referenced topic', () => {
    const blocks = buildHeterogeneousPrompt({
      isNewSession: true,
      prompt: '<refer_topic name="Previous" id="topic-ref" />\nSummarize it',
    });

    expect(blocks.map((block) => block.type === 'text' && block.text)).toEqual([
      lobeHubCliGuide,
      expect.stringContaining('`lh topic view <topic-id>`'),
      '<refer_topic name="Previous" id="topic-ref" />\nSummarize it',
    ]);
  });

  it('recognizes markdown-escaped topic tags', () => {
    const blocks = buildHeterogeneousPrompt({
      prompt: '\\<refer\\_topic name="Previous" id="topic-ref" />',
    });

    expect(blocks[0]).toEqual({
      text: expect.stringContaining('`lh topic view <topic-id>`'),
      type: 'text',
    });
  });
});
