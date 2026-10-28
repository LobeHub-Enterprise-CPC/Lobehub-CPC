import { conversationRouter } from './conversation';

/** Read-only access to previously shared conversations. Visitor execution is unsupported. */
export const shareChatRouter = conversationRouter;

export type ShareChatRouter = typeof shareChatRouter;
