import app from '@/server/router-hono/cron';

// Deployment-wide schedules: no tenant on the request. Each handler fans out
// to every available tenant and runs the work inside that tenant.
const handler = (request: Request) => app.fetch(request);

export const POST = handler;
