import { Hono } from 'hono';

import { qstashAuth } from '../middlewares/qstashAuth';
import { settleStaleRunning } from './handlers/settleStaleRunning';

const app = new Hono();

app.post('/settle-stale-running', qstashAuth(), settleStaleRunning);

export default app;
