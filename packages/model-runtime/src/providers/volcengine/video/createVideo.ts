import createDebug from 'debug';

import type { CreateVideoOptions } from '../../../core/openaiCompatibleFactory';
import type {
  CreateVideoPayload,
  CreateVideoResult,
  PollVideoStatusResult,
} from '../../../types/video';

const log = createDebug('lobe-video:volcengine');

interface VolcengineVideoTaskResponse {
  content?: {
    video_url?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  id?: string;
  status?: string;
}

/**
 * Poll the status of a Volcengine video generation task.
 *
 * Volcengine's task response shape is identical whether it arrives via webhook
 * push (see `handleCreateVideoWebhook.ts`) or this GET poll, so the
 * queued/running/succeeded/failed/expired parsing mirrors that handler.
 */
export async function pollVolcengineVideoStatus(
  taskId: string,
  apiKey: string,
  baseURL: string,
): Promise<PollVideoStatusResult> {
  const url = `${baseURL}/contents/generations/tasks/${taskId}`;

  log('Polling task status for: %s', taskId);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    method: 'GET',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to query task status for ${taskId} (${response.status}): ${errorText}`);
  }

  const data: VolcengineVideoTaskResponse = await response.json();

  if (data.status === 'succeeded') {
    const videoUrl = data.content?.video_url;
    if (!videoUrl) {
      return { error: 'Task succeeded but no video URL found', status: 'failed' };
    }
    return { status: 'success', videoUrl };
  }

  if (data.status === 'failed' || data.status === 'expired') {
    const errorMessage =
      data.error?.message ||
      (data.status === 'expired' ? 'Video generation task expired' : 'Video generation failed');
    return { error: errorMessage, status: 'failed' };
  }

  // queued, running, or any other in-flight status
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
    throw new Error(`Volcengine video API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  log('Volcengine video API response: %O', data);

  if (!data?.id) {
    throw new Error('Invalid response: missing task id');
  }

  // Only the webhook path is push-based; without a callback URL configured on
  // this request, the caller must fall back to `handlePollVideoStatus` polling
  // (some private/self-hosted deployments have no public endpoint for a
  // provider to call back into, so they never configure callbackUrl).
  return { inferenceId: data.id, useWebhook: !!payload.callbackUrl };
}
