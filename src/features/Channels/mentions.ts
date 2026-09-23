import { $getSelection, $isRangeSelection, $isTextNode } from 'lexical';

/** The editor's @ matcher requires a whitespace boundary, even after Chinese prose. */
export function $insertChannelMentionBoundary(event: KeyboardEvent): boolean {
  if (event.key !== '@' || event.isComposing) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.hasFormat('code'))
    return false;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node) || !node.isSimpleText() || node.hasFormat('code')) return false;
  const before = node.getTextContent().slice(0, selection.anchor.offset);
  if (!/[\p{Script=Han}，。！？、；：“”‘’（）【】《》「」『』]$/u.test(before)) return false;
  selection.insertText(' @');
  return true;
}

/** Only editor-created member chips select recipients; plain text and code never do. */
export function channelMentionIds(document: unknown, memberIds: string[]): string[] {
  const allowed = new Set(memberIds);
  const result = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.type === 'string' && /code/i.test(node.type)) return;
    const metadata = node.metadata as Record<string, unknown> | undefined;
    if (
      node.type === 'mention' &&
      metadata?.type === 'channel-member' &&
      typeof metadata.id === 'string' &&
      allowed.has(metadata.id)
    )
      result.add(metadata.id);
    if (node.root) visit(node.root);
    if (node.children) visit(node.children);
  };
  visit(document);
  return [...result];
}
