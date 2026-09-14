import { describe, expect, it } from 'vitest';

import { getApprovalContent } from './approvalContent';

describe('Channel permission content', () => {
  it('keeps the proposed command and directory without protocol identities', () => {
    expect(
      getApprovalContent({
        method: 'item/commandExecution/requestApproval',
        request: {
          command: 'node --test',
          cwd: '/project',
          reason: 'Run the project tests',
          threadId: 'private-thread',
          itemId: 'private-item',
          turnId: 'private-turn',
        },
      }),
    ).toBe('Run the project tests\nnode --test\n/project');
  });
  it('shows requested grant roots and structured approval details', () => {
    expect(
      getApprovalContent({
        request: {
          grantRoot: '/protected',
          command: ['sh', '-c', 'test'],
          changes: { mode: 'write' },
        },
      }),
    ).toContain('grantRoot: "/protected"');
    expect(getApprovalContent({ request: { grantRoot: true } })).toContain('grantRoot: true');
    expect(
      getApprovalContent({ tool: { arguments: { path: '/protected', overwrite: true } } }),
    ).toContain('overwrite');
  });
  it('keeps Native tool arguments without its private call id', () => {
    expect(
      getApprovalContent({
        tool: { id: 'private-call', apiName: 'readFile', arguments: '{"path":"README.md"}' },
      }),
    ).toBe('readFile\n{"path":"README.md"}');
  });
});
