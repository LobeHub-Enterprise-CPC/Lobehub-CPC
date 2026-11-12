/** Moving content between personal and enterprise libraries runs in one transaction, so a batch is capped. */
export const ENTERPRISE_CONTENT_MOVE_MAX_ITEMS = 1000;
