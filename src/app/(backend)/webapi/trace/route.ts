import { TraceEventType } from '@lobechat/types';

import { TraceClient } from '@/libs/traces';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { after } from '@/server/utils/scheduleAfterResponse';
import { type TraceEventBasePayload, type TraceEventPayloads } from '@/types/trace';

const handlePost = async (req: Request) => {
  type RequestData = TraceEventPayloads & TraceEventBasePayload;
  const data = (await req.json()) as RequestData;
  const { traceId, eventType } = data;

  const traceClient = new TraceClient();

  const eventClient = traceClient.createEvent(traceId);

  switch (eventType) {
    case TraceEventType.ModifyMessage: {
      eventClient?.modifyMessage(data);
      break;
    }

    case TraceEventType.DeleteAndRegenerateMessage: {
      eventClient?.deleteAndRegenerateMessage(data);
      break;
    }

    case TraceEventType.RegenerateMessage: {
      eventClient?.regenerateMessage(data);
      break;
    }

    case TraceEventType.CopyMessage: {
      eventClient?.copyMessage(data);
      break;
    }
  }

  after(async () => {
    await traceClient.shutdownAsync();
  });

  return new Response(undefined, { status: 201 });
};

export const POST = withTenantRequest(handlePost);
