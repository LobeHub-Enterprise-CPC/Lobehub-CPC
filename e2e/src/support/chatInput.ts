import type { CustomWorld } from './world';
import { WAIT_TIMEOUT } from './world';

export async function focusChatInput(this: CustomWorld): Promise<void> {
  // Wait until the chat input area is rendered (skeleton screen may still be visible).
  await this.page
    .waitForFunction(
      () => {
        const selectors = [
          '[data-testid="chat-input"] [contenteditable="true"]',
          '[data-testid="chat-input"] textarea',
          'textarea[placeholder*="Ask"]',
          'textarea[placeholder*="Press"]',
          'textarea[placeholder*="输入"]',
          'textarea[placeholder*="请输入"]',
          '[data-testid="chat-input"]',
        ];

        return selectors.some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((node) => {
            const element = node as HTMLElement;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden'
            );
          }),
        );
      },
      { timeout: WAIT_TIMEOUT },
    )
    .catch(() => {});

  const candidates = [
    {
      label: 'prompt textarea by placeholder',
      locator: this.page.locator(
        'textarea[placeholder*="Ask"], textarea[placeholder*="Press"], textarea[placeholder*="输入"], textarea[placeholder*="请输入"]',
      ),
    },
    {
      label: 'chat-input textarea',
      locator: this.page.locator('[data-testid="chat-input"] textarea'),
    },
    {
      label: 'chat-input contenteditable',
      locator: this.page.locator('[data-testid="chat-input"] [contenteditable="true"]'),
    },
    {
      label: 'visible textbox role',
      locator: this.page.getByRole('textbox'),
    },
    {
      label: 'chat-input container',
      locator: this.page.locator('[data-testid="chat-input"]'),
    },
  ];

  for (const { label, locator } of candidates) {
    const count = await locator.count();
    console.log(`   📍 Candidate "${label}" count: ${count}`);

    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      const visible = await item.isVisible().catch(() => false);
      if (!visible) continue;

      await item.click({ force: true });
      console.log(`   ✓ Focused ${label} at index ${i}`);
      return;
    }
  }

  throw new Error('Could not find a visible chat input to focus');
}
