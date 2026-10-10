import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { receiveVideoReceipt } from '@/server/modules/Tenant/videoReceipt';
import app from '@/server/router-hono/webhooks';

const handle = (request: Request) => app.fetch(request);

export const GET = withTenantRequest(handle);
const admittedPost = withTenantRequest(handle);
export const POST = async (request: Request) =>
  (await receiveVideoReceipt(request)) ?? admittedPost(request);
