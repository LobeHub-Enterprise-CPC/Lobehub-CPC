import { and, desc, eq, isNull } from 'drizzle-orm';

import { getServerDB } from '@/database/core/db-adaptor';
import { getActiveWorkspaceMembershipRole } from '@/database/models/workspace';
import { devices } from '@/database/schemas';
import type { GatewayPrincipal } from '@/server/services/gatewayAuthorization/types';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

export const canEditWorkspaceDevice = (
  role: string | undefined,
  actorUserId: string,
  enrollerUserId: string,
): boolean => role === 'owner' || enrollerUserId === actorUserId;

/**
 * Using a workspace device (as opposed to editing its registration) is open to
 * every member once it is public; read-only viewers never operate a machine.
 */
export const canOperateWorkspaceDevice = (
  role: string | undefined,
  actorUserId: string,
  row: { userId: string; visibility: 'private' | 'public' },
): boolean =>
  (row.visibility === 'public' && !!role && role !== 'viewer') ||
  canEditWorkspaceDevice(role, actorUserId, row.userId);

export const gatewayDeviceTarget = async (
  subject: string,
  principal: GatewayPrincipal,
  deviceId?: string,
) => {
  const db = await getServerDB();
  const role =
    principal.kind === 'workspace'
      ? await getActiveWorkspaceMembershipRole(db, { userId: subject, workspaceId: principal.id })
      : undefined;
  if (principal.kind === 'workspace' && !role)
    throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  const rows = await db
    .select()
    .from(devices)
    .where(
      and(
        principal.kind === 'workspace'
          ? eq(devices.workspaceId, principal.id)
          : and(eq(devices.userId, principal.id), isNull(devices.workspaceId)),
        deviceId ? eq(devices.deviceId, deviceId) : undefined,
      ),
    )
    .orderBy(desc(devices.lastSeenAt));
  const row = rows.find(
    (entry) =>
      principal.kind === 'user' || canOperateWorkspaceDevice(role ?? undefined, subject, entry),
  );
  if (!row) throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  return row.deviceId;
};

/**
 * Whether `subject` may speak for the workspace device `deviceId` on the
 * gateway, which is decided here, by Work, and signed into the ticket: the
 * client's report of its own device is never the authority.
 *
 * A device that is not enrolled yet may be claimed (that is the first
 * connection of an enrollment). One that is enrolled may be claimed by its
 * enroller, by an owner, and, once public, by any non-viewer member: another
 * member's private device never. A personal principal has a pool of its own, so
 * there is nothing to take over.
 */
export const assertGatewayDeviceClaim = async (
  subject: string,
  principal: GatewayPrincipal,
  deviceId: string,
) => {
  if (principal.kind !== 'workspace') return;
  const db = await getServerDB();
  const role = await getActiveWorkspaceMembershipRole(db, {
    userId: subject,
    workspaceId: principal.id,
  });
  if (!role) throw new GatewayAuthorizationError('FORBIDDEN', 403);
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.workspaceId, principal.id), eq(devices.deviceId, deviceId)))
    .limit(1);
  if (row && !canOperateWorkspaceDevice(role ?? undefined, subject, row))
    throw new GatewayAuthorizationError('FORBIDDEN', 403);
};
