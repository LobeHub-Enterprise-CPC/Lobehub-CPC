import createDebug from 'debug';

import type { CreateVideoOptions } from '../../../core/openaiCompatibleFactory';
import { SubmissionRejectedError } from '../../../errors/submissionRejected';
import type {
  CreateVideoPayload,
  CreateVideoResult,
  PollVideoStatusResult,
} from '../../../types/video';

const log = createDebug('lobe-video:volcengine');

/**
 * A single status query must not block for longer than this. The status endpoint
 * either answers quickly or is unhealthy; the caller retries transient failures on
 * its own interval, so hanging here would only eat the caller's polling budget.
 */
const STATUS_QUERY_TIMEOUT_MS = 30_000;

interface VolcengineVideoTaskResponse {
  content?: { video_url?: string };
  error?: { code?: string; message?: string };
  id?: string;
  status?: string;
}

export async function pollVolcengineVideoStatus(
  taskId: string,
  apiKey: string,
  baseURL: string,
): Promise<PollVideoStatusResult> {
  const response = await fetch(`${baseURL}/contents/generations/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    method: 'GET',
    signal: AbortSignal.timeout(STATUS_QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log(
      'Volcengine video status query failed for task %s: %s %s',
      taskId,
      response.status,
      errorText,
    );
    throw new Error(`Failed to query task status for ${taskId} (${response.status}): ${errorText}`);
  }

  const data: VolcengineVideoTaskResponse = await response.json();
  // Upstream terminal state, logged with the task id so a task id from the database
  // can be traced to what Ark actually reported.
  log('Volcengine video task %s status: %s', taskId, data.status);
  if (data.status === 'succeeded') {
    const videoUrl = data.content?.video_url;
    return videoUrl
      ? { status: 'success', videoUrl }
      : { error: 'Task succeeded but no video URL found', status: 'failed' };
  }
  if (data.status === 'failed' || data.status === 'expired') {
    return {
      error:
        data.error?.message ||
        (data.status === 'expired' ? 'Video generation task expired' : 'Video generation failed'),
      status: 'failed',
    };
  }
  return { status: 'pending' };
}

/**
 * Volcengine video generation implementation
 * API docs: https://www.volcengine.com/docs/232791/1399051
 */
export async function createVolcengineVideo(
  payload: CreateVideoPayload,
  options: CreateVideoOptions,
): Promise<CreateVideoResult> {
  const { model, params } = payload;
  const {
    prompt,
    imageUrl,
    imageUrls,
    endImageUrl,
    aspectRatio,
    duration,
    generateAudio,
    webSearch,
    watermark,
    seed,
    resolution,
    cameraFixed,
  } = params;

  log('Creating video with Volcengine API - model: %s, params: %O', model, params);

  const baseURL = options.baseURL || 'https://ark.cn-beijing.volces.com/api/v3';

  // Build content array
  const content: Record<string, unknown>[] = [{ text: prompt, type: 'text' }];

  if (imageUrl) {
    content.push({ image_url: { url: imageUrl }, role: 'first_frame', type: 'image_url' });
  }

  if (imageUrls && imageUrls.length > 0) {
    if (imageUrls.length === 1 && endImageUrl) {
      content.push({ image_url: { url: imageUrls[0] }, role: 'first_frame', type: 'image_url' });
    } else {
      imageUrls.forEach((url) =>
        content.push({ image_url: { url }, role: 'reference_image', type: 'image_url' }),
      );
    }
  }

  if (endImageUrl) {
    content.push({ image_url: { url: endImageUrl }, role: 'last_frame', type: 'image_url' });
  }

  // Build request body
  const body: Record<string, unknown> = {
    content,
    model,
    watermark: watermark ?? false,
    ...(webSearch && { tools: [{ type: 'web_search' }] }),
  };

  if (aspectRatio !== undefined) body.ratio = aspectRatio;
  if (duration !== undefined) body.duration = duration;
  if (generateAudio !== undefined) body.generate_audio = generateAudio;
  if (seed !== undefined && seed !== null) body.seed = seed;
  if (resolution !== undefined) body.resolution = resolution;
  if (cameraFixed !== undefined) body.camera_fixed = cameraFixed;
  if (payload.callbackUrl) body.callback_url = payload.callbackUrl;

  log('Volcengine video API request body: %s', JSON.stringify(body, null, 2));

  const response = await fetch(`${baseURL}/contents/generations/tasks`, {
    body: JSON.stringify(body),
    headers: {
      'Authorization': `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    const errorText = await response.text();
    log('Volcengine video API error: %s %s', response.status, errorText);
    if ([400, 401, 403, 422].includes(response.status))
      throw new SubmissionRejectedError(
        `Volcengine video API error: ${response.status} ${errorText}`,
        'volcengine',
        response.status,
      );
    throw new Error(`Volcengine video API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  log('Volcengine video API response: %O', data);

  if (!data?.id) {
    throw new Error('Invalid response: missing task id');
  }

  return { inferenceId: data.id };
}
