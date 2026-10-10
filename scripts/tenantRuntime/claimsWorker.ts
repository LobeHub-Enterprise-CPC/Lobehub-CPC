/** Real OS-process fixture; never connects without the parent-provided isolated URL. */
import { createInterface } from 'node:readline';

import { getTenantLiveResources } from '../../apps/server/src/modules/Tenant/liveResources';
import { tenantClaims } from '../../apps/server/src/modules/Tenant/postgresClaims';

const running = new Map<string, () => void>();
const send = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const { action, tenantId } = JSON.parse(line);
  try {
    if (action === 'start') {
      const release = await tenantClaims.enter(tenantId);
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const unbind = getTenantLiveResources().bind(tenantId, {
        close: () => {
          send({ event: 'cancel', tenantId });
        },
        settled,
      });
      running.set(tenantId, () => {
        finish();
        unbind();
        running.delete(tenantId);
      });
      await release();
    } else if (action === 'finish') running.get(tenantId)?.();
    else throw new Error('unknown action');
    send({ event: action, tenantId });
  } catch (error) {
    send({
      event: 'error',
      tenantId,
      code: (error as Error & { code?: string }).code ?? (error as Error).message,
    });
  }
}
