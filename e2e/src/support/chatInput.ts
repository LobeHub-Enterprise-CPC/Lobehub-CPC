import { expect, type Locator } from '@playwright/test';

import type { CustomWorld } from './world';
import { WAIT_TIMEOUT } from './world';

export async function focusChatInput(this: CustomWorld): Promise<Locator> {
  const editor = this.page
    .locator(
      '[data-testid="chat-input"] [contenteditable="true"]:visible, [data-testid="chat-input"] textarea:visible',
    )
    .first();

  await expect(editor).toBeVisible({ timeout: WAIT_TIMEOUT });
  await expect(editor).toBeEditable();
  // Let Playwright wait for hit testing and animations. A forced click can
  // land on an overlay, and a visible composer wrapper cannot receive text.
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}
