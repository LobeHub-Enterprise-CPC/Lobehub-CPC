// set timeout to about 5 minutes, and give 2s padding time
export const ASYNC_TASK_TIMEOUT = (60 * 5 - 2) * 1000;

// Video generation is the only async task whose completion comes from a *remote
// render* (a provider callback or a status poll) followed by a download/store step,
// so the generic ASYNC_TASK_TIMEOUT above must not bound it. Three budgets have to
// stay in this order:
//
//   VIDEO_GENERATION_POLL_TIMEOUT   how long the poller waits on the provider
//   TRPC_ASYNC_MAX_DURATION         the window the poller runs inside
//   VIDEO_GENERATION_TASK_TIMEOUT   when the watchdog may declare the task dead
//
// The deadline is the largest because it is measured from `created_at` while the
// poller only starts once the request has written the task row and `after()` has
// picked the job up, and because whatever follows the upstream render — download,
// thumbnail/cover generation, storage, asset+file creation, completion charge —
// still has to fit. Equal deadlines are what made the watchdog kill tasks whose
// render was still in flight.
/**
 * How long the background poller keeps asking the provider for a task's status.
 * Sized for the render itself (Seedance observed at 95–198s; providers publish no
 * hard ceiling), and small enough that a full poll budget still leaves room to store
 * the result inside the TRPC_ASYNC_MAX_DURATION window below.
 */
export const VIDEO_GENERATION_POLL_TIMEOUT = 60 * 7 * 1000;

/**
 * Deadline for a video async task, measured from `created_at`. Sits above both the
 * poll budget and the invocation window it runs in, so the watchdog can only fire
 * once polling and result handling have genuinely had their time.
 */
export const VIDEO_GENERATION_TASK_TIMEOUT = 60 * 10 * 1000;

// The lambda router's after() background jobs (video/image polling) need to
// outlive the request that scheduled them — without an explicit maxDuration
// the route runs under the platform default, which is normally far shorter
// than a multi-minute video generation task, so the poll loop gets killed
// mid-flight with no error ever thrown (see ASYNC_TASK_TIMEOUT above, which
// is what eventually surfaces the generic "task is timeout" to the client).
//
// 600s covers VIDEO_GENERATION_POLL_TIMEOUT plus the result-handling step, and
// matches the window the agent run-step route already assumes
// (STEP_INVOCATION_MAX_DURATION_MS). Keep in sync with the `maxDuration` literal in
// src/app/(backend)/trpc/lambda/[trpc]/route.ts, which Next.js requires to be
// statically analysable.
export const TRPC_ASYNC_MAX_DURATION: number = 600;
// export const TRPC_TOOLS_MAX_DURATION: number | undefined = undefined;

// export const WEBAPI_CHAT_MAX_DURATION: number = 300;
// export const WEBAPI_PLUGIN_GATEWAY_MAX_DURATION: number | undefined = undefined;
