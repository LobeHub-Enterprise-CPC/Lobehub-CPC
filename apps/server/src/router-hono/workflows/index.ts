import { stripTenantPath } from '@lobechat/const/tenantPath';
import { Hono } from 'hono';
import { getPath } from 'hono/utils/url';

import agentEvalRunApp from './agent-eval-run';
import agentSignalApp from './agent-signal';
import expertiseHistoryApp from './expertise-history';
import expertiseRejectionApp from './expertise-rejection';
import goalApp from './goal';
import memoryUserMemoryApp from './memory-user-memory';
import onboardingTaskRecommendationApp from './onboarding-task-recommendation';
import onboardingUnderstandingApp from './onboarding-understanding';
import taskApp from './task';
import topicAutoSummaryApp from './topic-auto-summary';
import trashApp from './trash';
import verifyApp from './verify';
import widgetApp from './widget';

// Requests arrive with their tenant address (see the route shell); routing
// ignores the tenant prefix, which the proxy has already resolved and signed.
const app = new Hono({ getPath: (request) => stripTenantPath(getPath(request)) }).basePath(
  '/api/workflows',
);

app.route('/agent-eval-run', agentEvalRunApp);
app.route('/agent-signal', agentSignalApp);
app.route('/expertise-history', expertiseHistoryApp);
app.route('/expertise-rejection', expertiseRejectionApp);
app.route('/goal', goalApp);
app.route('/memory-user-memory', memoryUserMemoryApp);
app.route('/onboarding/understanding', onboardingUnderstandingApp);
app.route('/onboarding/task-recommendations', onboardingTaskRecommendationApp);
app.route('/task', taskApp);
app.route('/topic-auto-summary', topicAutoSummaryApp);
app.route('/trash', trashApp);
app.route('/verify', verifyApp);
app.route('/widget', widgetApp);

export default app;
