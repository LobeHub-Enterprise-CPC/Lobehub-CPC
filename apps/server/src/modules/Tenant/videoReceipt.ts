import { createHash } from 'node:crypto';

import { parseTenantPath } from '@lobechat/business-tenant/routing';
import {
  getPlatformDB,
  tenantDirectory,
  tenantLifecycle,
  tenantRuntimeExternalWork,
} from '@lobechat/database/platform';
import { ModelRuntime } from '@lobechat/model-runtime';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { effectiveTenantState } from '@/server/services/tenantControlPlane/service';

import { routedTenantSlug } from './gate';

/** Authenticated receipt ingress only. Never opens the tenant database or resumes business work. */
export const receiveVideoReceipt = async (request: Request): Promise<Response | undefined> => {
  const url = new URL(request.url);
  const path = parseTenantPath(url.pathname);
  const match = path.rest.match(/^\/api\/webhooks\/video\/([^/]+)$/);
  if (request.method !== 'POST' || !match) return;
  const slug = routedTenantSlug(request);
  const token = url.searchParams.get('token');
  if (!slug || !token || (path.tenantSlug && path.tenantSlug !== slug)) return;
  const provider = decodeURIComponent(match[1]);
  const digest = createHash('sha256').update(token).digest('hex');
  const db = getPlatformDB();
  const [record] = await db
    .select({ work: tenantRuntimeExternalWork, lifecycle: tenantLifecycle })
    .from(tenantRuntimeExternalWork)
    .innerJoin(tenantDirectory, eq(tenantDirectory.tenantId, tenantRuntimeExternalWork.tenantId))
    .innerJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenantDirectory.tenantId))
    .where(
      and(
        eq(tenantDirectory.slug, slug),
        eq(tenantRuntimeExternalWork.kind, 'video'),
        sql`${tenantRuntimeExternalWork.context}->>'webhookTokenHash' = ${digest}`,
        sql`${tenantRuntimeExternalWork.context}->>'provider' = ${provider}`,
      ),
    )
    .limit(1);
  if (!record) return;
  const { work, lifecycle } = record;
  const frozen =
    effectiveTenantState(
      {
        desiredState: lifecycle.desiredState,
        expiresAt: lifecycle.expiresAt?.toISOString() ?? null,
        freezeReasons: lifecycle.freezeReasons,
      },
      new Date(),
    ).state !== 'active';
  let rawBody: string;
  let body: unknown;
  try {
    rawBody = await request.clone().text();
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const runtime = ModelRuntime.initializeWithProvider(provider, { apiKey: 'webhook-placeholder' });
  const result = await runtime.handleCreateVideoWebhook({
    body,
    rawBody,
    headers: Object.fromEntries(request.headers),
    model: String(work.context?.model || ''),
    url: request.url,
  });
  if (!result || !work.handle || result.inferenceId !== work.handle)
    return Response.json({ error: 'Receipt does not match submitted work' }, { status: 409 });
  if (result.status === 'success' || result.status === 'error') {
    await db
      .update(tenantRuntimeExternalWork)
      .set({ completedAt: new Date(), receipt: { source: 'authenticated-webhook', result } })
      .where(
        and(
          eq(tenantRuntimeExternalWork.workId, work.workId),
          eq(tenantRuntimeExternalWork.tenantId, work.tenantId),
          isNull(tenantRuntimeExternalWork.completedAt),
        ),
      );
    if (frozen) return Response.json({ received: true, businessCompletion: 'deferred' });
  } else if (frozen) {
    // 'completed' without an artifact still needs provider polling. Never count it as terminal.
    return Response.json(
      { received: result.status === 'pending' },
      { status: result.status === 'pending' ? 200 : 503 },
    );
  }
};
