/**
 * Agent Conversation Steps
 *
 * Step definitions for Agent conversation E2E tests
 */
import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

import { llmMockManager, presetResponses } from '../../mocks/llm';
import { focusChatInput } from '../../support/chatInput';
import { tenantPath } from '../../support/tenant';
import type { CustomWorld } from '../../support/world';

// ============================================
// Given Steps
// ============================================

Given('用户已登录系统', async function (this: CustomWorld) {
  // Session cookies are already set by the Before hook
  // Just verify we have cookies
  const cookies = await this.browserContext.cookies();
  expect(cookies.length).toBeGreaterThan(0);
});

Given('用户进入 Lobe AI 对话页面', { timeout: 30_000 }, async function (this: CustomWorld) {
  console.log('   📍 Step: 设置 LLM mock...');
  // Setup LLM mock before navigation
  llmMockManager.setResponse('hello', presetResponses.greeting);
  await llmMockManager.setup(this.page);

  console.log('   📍 Step: 直接进入 Lobe AI 对话路由...');
  await this.page.goto(tenantPath('/agent/inbox'), { waitUntil: 'domcontentloaded' });

  console.log('   📍 Step: 查找输入框...');
  await focusChatInput.call(this);

  // Wait for any animations to complete
  await this.page.waitForTimeout(100);

  console.log('   ✅ 已进入 Lobe AI 对话页面');
});

// ============================================
// When Steps
// ============================================

/**
 * Given step for when user has already sent a message
 * This sends a message and waits for the AI response
 */
Given('用户已发送消息 {string}', async function (this: CustomWorld, message: string) {
  console.log(`   📍 Step: 发送消息 "${message}" 并等待回复...`);

  await focusChatInput.call(this);
  await this.page.waitForTimeout(500);

  // Type the message
  await this.page.keyboard.type(message, { delay: 30 });
  await this.page.waitForTimeout(300);

  // Send the message
  await this.page.keyboard.press('Enter');

  // Wait for the message to be sent
  await this.page.waitForTimeout(1000);

  // Wait for the assistant response to appear
  // Assistant messages are left-aligned .message-wrapper elements that contain "Lobe AI" title
  console.log('   📍 Step: 等待助手回复...');

  // Wait for any new message wrapper to appear (there should be at least 2 - user + assistant)
  const messageWrappers = this.page.locator('.message-wrapper');
  await expect(messageWrappers)
    .toHaveCount(2, { timeout: 15_000 })
    .catch(() => {
      // Fallback: just wait for at least one message wrapper
      console.log('   📍 Fallback: checking for any message wrapper');
    });

  // Verify the assistant message contains expected content
  const assistantMessage = this.page.locator('.message-wrapper').filter({
    has: this.page.locator('text=Lobe AI'),
  });
  await expect(assistantMessage).toBeVisible({ timeout: 5000 });

  this.testContext.lastMessage = message;
  console.log(`   ✅ 消息已发送并收到回复`);
});

When('用户发送消息 {string}', async function (this: CustomWorld, message: string) {
  console.log(`   📍 Step: 查找输入框...`);

  console.log(`   📍 Step: 点击输入区域...`);
  await focusChatInput.call(this);
  await this.page.waitForTimeout(500);

  console.log(`   📍 Step: 输入消息 "${message}"...`);
  // Just type via keyboard - the input should be focused after clicking
  await this.page.keyboard.type(message, { delay: 30 });
  await this.page.waitForTimeout(300);

  console.log(`   📍 Step: 发送消息 (按 Enter)...`);
  await this.page.keyboard.press('Enter');

  // Wait for the message to be sent and processed
  await this.page.waitForTimeout(1000);

  console.log(`   ✅ 消息已发送`);
  this.testContext.lastMessage = message;
});

// ============================================
// Then Steps
// ============================================

Then('用户应该收到助手的回复', async function (this: CustomWorld) {
  // Wait for the assistant response to appear
  // The response should be in a message bubble with role="assistant" or similar
  const assistantMessage = this.page
    .locator('[data-role="assistant"], [class*="assistant"], [class*="message"]')
    .last();

  await expect(assistantMessage).toBeVisible({ timeout: 15_000 });
});

Then('回复内容应该可见', async function (this: CustomWorld) {
  const assistantMessage = this.page.locator('.message-wrapper').filter({
    has: this.page.locator('.message-header', { hasText: /Lobe AI|AI/ }),
  });
  await expect(assistantMessage.last()).toBeVisible({ timeout: 15_000 });

  // Streaming responses may render an empty first child initially, so poll full text.
  let finalText = '';
  await expect
    .poll(
      async () => {
        const rawText =
          (await assistantMessage
            .last()
            .innerText()
            .catch(() => '')) || '';
        finalText = rawText
          .replaceAll(/Lobe AI/gi, '')
          .replaceAll(/[·•]/g, '')
          .trim();
        return finalText.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  console.log(`   ✅ Assistant replied: "${finalText.slice(0, 50)}..."`);
});
