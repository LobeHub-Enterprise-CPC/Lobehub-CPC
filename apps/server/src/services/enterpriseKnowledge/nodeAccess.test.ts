import { describe, expect, it } from 'vitest';

import { calculateNodeAccess, type EnterpriseNode } from './nodeAccess';

const node = (
  id: string,
  parentId: string | null,
  kind: EnterpriseNode['kind'] = 'folder',
  fileId?: string,
): EnterpriseNode => ({ id, parentId, kind, name: id, aliasOf: fileId, isDeleted: false });
const tree = (
  libraryLevel: 'edit' | 'view' | null,
  nodes: { nodeId: string; level: 'edit' | 'view' | null }[],
) => ({ knowledgeBaseId: 'kb', ownerId: 'owner', libraryLevel, nodes, owner: false });

describe('enterprise node access', () => {
  it('replaces the inherited list, including an empty grant, through multiple generations', () => {
    const result = calculateNodeAccess(
      [node('a', null), node('b', 'a'), node('c', 'b', 'file'), node('d', null, 'file')],
      tree('edit', [{ nodeId: 'a', level: null }]),
    );
    expect([...result.levels]).toEqual([
      ['a', null],
      ['b', null],
      ['c', null],
      ['d', 'edit'],
    ]);
  });
  it('exposes only folder paths to a granted leaf and removes paths after revocation', () => {
    const nodes = [
      node('a', null),
      node('b', 'a'),
      node('yes', 'b', 'file'),
      node('no', 'b', 'file'),
    ];
    const result = calculateNodeAccess(nodes, tree(null, [{ nodeId: 'yes', level: 'view' }]));
    expect(result.rootLevel).toBe('path');
    expect([...result.levels]).toEqual([
      ['a', 'path'],
      ['b', 'path'],
      ['yes', 'view'],
      ['no', null],
    ]);
    expect(calculateNodeAccess(nodes, tree(null, [])).rootLevel).toBeNull();
  });
  it('makes mirror documents follow the file, ignoring their parent and policy', () => {
    const result = calculateNodeAccess(
      [node('a', null), node('f', 'a', 'file'), node('mirror', null, 'document', 'f')],
      tree('edit', [
        { nodeId: 'a', level: null },
        { nodeId: 'mirror', level: 'edit' },
      ]),
    );
    expect(result.levels.get('mirror')).toBeNull();
  });
  it('denies cycles, missing parents, deleted branches and nonexistent mirror files', () => {
    const nodes = [
      node('a', 'b'),
      node('b', 'a'),
      node('orphan', 'missing', 'file'),
      { ...node('deleted', null), isDeleted: true },
      node('child', 'deleted', 'file'),
      node('mirror', null, 'document', 'missing'),
    ];
    const result = calculateNodeAccess(nodes, tree('edit', [{ nodeId: 'child', level: 'view' }]));
    expect([...result.levels.values()]).toEqual(nodes.map(() => null));
  });
  it('gives the owner full access even when a node has an empty list', () => {
    const result = calculateNodeAccess([node('a', null)], {
      ...tree(null, [{ nodeId: 'a', level: null }]),
      owner: true,
    });
    expect(result.rootLevel).toBe('owner');
    expect(result.levels.get('a')).toBe('owner');
  });
});
