/** Show the proposed action, not the runtime's request/turn/run identifiers. */
export function getApprovalContent(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const envelope = value as Record<string, unknown>;
  const request = (envelope.tool || envelope.request || {}) as Record<string, unknown>;
  const details = [request.reason, request.command, request.cwd, request.grantRoot];
  if (envelope.tool) {
    details.push(request.apiName, request.arguments);
  }
  if (request.changes) details.push(JSON.stringify(request.changes, null, 2));
  return details.filter((item): item is string => typeof item === 'string' && !!item).join('\n');
}
