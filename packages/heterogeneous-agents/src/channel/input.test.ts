import type { ChannelInputManifest } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { channelInput } from './input';

describe('Channel identity envelope', () => {
  const manifest: ChannelInputManifest = {
    self: { memberId: 'self', name: 'Reviewer' },
    cutoffSequence: 8,
    threadId: 'branch',
    threadRootSequence: 4,
    source: 'reconstructed',
    sessionGeneration: 2,
    requestMessageId: 'request',
    messages: [
      {
        id: 'own-history',
        author: { id: 'self', name: 'Reviewer', type: 'member' },
        content: 'Previously reported /old-directory',
        sequence: 4,
        threadId: null,
      },
      {
        id: 'other-history',
        author: { id: 'other', name: 'Reviewer', type: 'member' },
        content: 'A different member with the same name',
        sequence: 6,
        threadId: 'branch',
      },
      {
        id: 'request',
        author: { id: 'owner', name: 'Owner', type: 'human' },
        content: 'Who else replied?',
        sequence: 8,
        threadId: 'branch',
      },
    ],
  };

  it('retains own history and distinguishes same-name authors without rewriting public messages', () => {
    const before = JSON.stringify(manifest);
    const wire = JSON.parse(channelInput(manifest));
    expect(wire).toEqual({
      deliveryInstruction: expect.stringContaining('ordinary Channel message'),
      self: { memberId: 'self', name: 'Reviewer' },
      threadId: 'branch',
      threadRootSequence: 4,
      cutoffSequence: 8,
      contextMode: 'snapshot',
      activeRequestMessageId: 'request',
      newMessages: manifest.messages,
    });
    expect(JSON.stringify(manifest)).toBe(before);
  });

  it('clears earlier autonomous instructions on normal deliveries without reducing tools', () => {
    const wire = JSON.parse(channelInput({ ...manifest, source: 'incremental' }));
    expect(wire.discussion).toBeUndefined();
    expect(wire.deliveryInstruction).toContain('do not apply to this turn');
    expect(wire.deliveryInstruction).toContain('Keep your normal tools and capabilities');
    expect(wire.contextMode).toBe('delta');
    expect(wire.newMessages).toEqual(manifest.messages);
  });

  it('reads legacy manifests without guessing identity or a branch boundary from history', () => {
    const { self: _self, threadRootSequence: _root, ...legacy } = manifest;
    const before = JSON.stringify(legacy);
    expect(JSON.parse(channelInput(legacy))).toMatchObject({
      self: null,
      threadRootSequence: null,
      threadId: 'branch',
      newMessages: manifest.messages,
    });
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
