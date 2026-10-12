/**
 * Home Sidebar Agent Steps
 *
 * Step definitions for Home page Agent management E2E tests
 * - Rename
 * - Pin/Unpin
 * - Delete
 */
import { randomBytes } from 'node:crypto';

import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

import { TEST_USER } from '../../support/seedTestUser';
import { tenantClientConfig, tenantPath } from '../../support/tenant';
import { type CustomWorld, WAIT_TIMEOUT } from '../../support/world';

// ============================================
// Helper Functions
// ============================================

async function inputNewName(
  this: CustomWorld,
  newName: string,
  pressEnter: boolean,
): Promise<void> {
  await this.page.waitForTimeout(300);

  // Rename opens the shared rename dialog, not an inline popover input.
  const dialog = this.page.getByRole('dialog').first();
  const renameInput = dialog.locator('input').first();

  await renameInput.waitFor({ state: 'visible', timeout: 5000 });
  await renameInput.click();
  await renameInput.clear();
  await renameInput.fill(newName);

  if (pressEnter) {
    await renameInput.press('Enter');
  } else {
    const saveButton = dialog.getByRole('button', { name: /^(save|保存)$/i });
    try {
      await saveButton.waitFor({ state: 'visible', timeout: 2000 });
      await saveButton.click();
    } catch {
      // Fallback: press Enter to save
      await renameInput.press('Enter');
    }
  }

  await this.page.waitForTimeout(1000);
  console.log(`   ✅ 已输入新名称 "${newName}"`);
}

/**
 * Create a test agent directly in database
 */
async function createTestAgent(title: string = 'Test Agent'): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set');

  const { default: pg } = await import('pg');
  const client = new pg.Client(tenantClientConfig(databaseUrl));

  try {
    await client.connect();

    const now = new Date().toISOString();
    const suffix = randomBytes(6).toString('hex');
    const agentId = `agent_e2e_test_${suffix}`;
    const slug = `test-agent-${suffix}`;

    await client.query(
      `INSERT INTO agents (id, slug, title, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT DO NOTHING`,
      [agentId, slug, title, TEST_USER.id, now],
    );

    console.log(`   📍 Created test agent in DB: ${agentId}`);
    return agentId;
  } finally {
    await client.end();
  }
}

async function waitForAgentItem(this: CustomWorld, agentId: string) {
  const selector = `a[href$="/agent/${agentId}"]`;
  const agentItem = this.page.locator(selector).first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(agentItem).toBeVisible({ timeout: WAIT_TIMEOUT });
      return { agentItem, selector };
    } catch (error) {
      if (attempt === 2) throw error;
      console.log(`   ↻ Agent ${agentId} not visible yet, reloading Home page...`);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(1000);
    }
  }

  return { agentItem, selector };
}

// ============================================
// Given Steps
// ============================================

Given('用户在 Home 页面有一个 Agent', { timeout: 30_000 }, async function (this: CustomWorld) {
  console.log('   📍 Step: 在数据库中创建测试 Agent...');
  const agentId = await createTestAgent('E2E Test Agent');
  this.testContext.createdAgentId = agentId;

  console.log('   📍 Step: 导航到 Home 页面...');
  await this.page.goto(tenantPath('/'));
  await this.page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
  await this.page.waitForTimeout(1000);

  console.log('   📍 Step: 查找新创建的 Agent...');
  // Look for the newly created agent in the sidebar by its specific ID. Use a
  // suffix match so workspace-prefixed links (e.g. /:workspaceSlug/agent/:id)
  // are accepted as well.
  const { agentItem, selector } = await waitForAgentItem.call(this, agentId);

  // Store agent reference for later use
  const agentLabel = await agentItem.getAttribute('aria-label');
  this.testContext.targetItemId = agentLabel || agentId;
  this.testContext.targetItemSelector = selector;
  this.testContext.targetType = 'agent';

  console.log(`   ✅ 找到 Agent: ${agentLabel}, id: ${agentId}`);
});

Given('该 Agent 未被置顶', { timeout: 30_000 }, async function (this: CustomWorld) {
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  const pinIcon = targetItem.locator('svg.lucide-pin');
  if ((await pinIcon.count()) > 0) {
    await targetItem.click({ button: 'right' });
    const unpinOption = this.page.getByRole('menuitem', { name: /^(unpin|取消置顶)$/i });
    await expect(unpinOption).toBeVisible();
    await unpinOption.click();
  }
  await expect(pinIcon).toHaveCount(0);
});

Given('该 Agent 已被置顶', { timeout: 30_000 }, async function (this: CustomWorld) {
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  const pinIcon = targetItem.locator('svg.lucide-pin');
  if ((await pinIcon.count()) === 0) {
    await targetItem.click({ button: 'right' });
    const pinOption = this.page.getByRole('menuitem', { name: /^(pin|置顶)$/i });
    await expect(pinOption).toBeVisible();
    await pinOption.click();
  }
  // The mutation and list revalidation are async. A click alone does not
  // establish the pinned state needed by the next context-menu interaction.
  await expect(pinIcon).toHaveCount(1, { timeout: WAIT_TIMEOUT });
});

// ============================================
// When Steps
// ============================================

When('用户右键点击该 Agent', { timeout: 30_000 }, async function (this: CustomWorld) {
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  await targetItem.click({ button: 'right' });
  await expect(this.page.getByRole('menuitem').first()).toBeVisible();
});

When('用户悬停在该 Agent 上', async function (this: CustomWorld) {
  console.log('   📍 Step: 悬停在 Agent 上...');

  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  await targetItem.hover();
  await this.page.waitForTimeout(500);

  console.log('   ✅ 已悬停在 Agent 上');
});

When('用户点击更多操作按钮', async function (this: CustomWorld) {
  console.log('   📍 Step: 点击更多操作按钮...');

  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  const moreButton = targetItem.locator('svg.lucide-ellipsis, svg.lucide-more-horizontal').first();

  if ((await moreButton.count()) > 0) {
    await moreButton.click();
  } else {
    // Fallback: find any visible ellipsis button
    const allEllipsis = this.page.locator('svg.lucide-ellipsis');
    for (let i = 0; i < (await allEllipsis.count()); i++) {
      const ellipsis = allEllipsis.nth(i);
      if (await ellipsis.isVisible()) {
        await ellipsis.click();
        break;
      }
    }
  }

  await this.page.waitForTimeout(500);
  console.log('   ✅ 已点击更多操作按钮');
});

When('用户在菜单中选择重命名', async function (this: CustomWorld) {
  console.log('   📍 Step: 选择重命名选项...');

  const renameOption = this.page.getByRole('menuitem', { name: /^(rename|重命名)$/i });
  await expect(renameOption).toBeVisible({ timeout: 5000 });
  await renameOption.click();
  await this.page.waitForTimeout(500);

  console.log('   ✅ 已选择重命名选项');
});

When('用户在菜单中选择置顶', async function (this: CustomWorld) {
  console.log('   📍 Step: 选择置顶选项...');

  const pinOption = this.page.getByRole('menuitem', { name: /^(pin|置顶)$/i });
  await expect(pinOption).toBeVisible({ timeout: 5000 });
  await pinOption.click();
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  await expect(targetItem.locator('svg.lucide-pin')).toHaveCount(1, {
    timeout: WAIT_TIMEOUT,
  });

  console.log('   ✅ 已选择置顶选项');
});

When('用户在菜单中选择取消置顶', async function (this: CustomWorld) {
  console.log('   📍 Step: 选择取消置顶选项...');

  const unpinOption = this.page.getByRole('menuitem', { name: /^(unpin|取消置顶)$/i });
  await expect(unpinOption).toBeVisible({ timeout: 5000 });
  await unpinOption.click();
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  await expect(targetItem.locator('svg.lucide-pin')).toHaveCount(0, {
    timeout: WAIT_TIMEOUT,
  });

  console.log('   ✅ 已选择取消置顶选项');
});

When('用户在菜单中选择删除', async function (this: CustomWorld) {
  console.log('   📍 Step: 选择删除选项...');

  const deleteOption = this.page.getByRole('menuitem', { name: /^(delete|删除)$/i });
  await expect(deleteOption).toBeVisible({ timeout: 5000 });
  await deleteOption.click();
  await this.page.waitForTimeout(300);

  console.log('   ✅ 已选择删除选项');
});

When('用户在弹窗中确认删除', async function (this: CustomWorld) {
  console.log('   📍 Step: 确认删除...');

  const confirmButton = this.page
    .getByRole('dialog')
    .getByRole('button', { name: /^(ok|delete|删除|确认|确定)$/i });
  await expect(confirmButton).toBeVisible({ timeout: 5000 });
  await confirmButton.click();
  await this.page.waitForTimeout(500);

  console.log('   ✅ 已确认删除');
});

When('用户输入新的名称 {string}', async function (this: CustomWorld, newName: string) {
  console.log(`   📍 Step: 输入新名称 "${newName}"...`);
  await inputNewName.call(this, newName, false);
});

When('用户输入新的名称 {string} 并按 Enter', async function (this: CustomWorld, newName: string) {
  console.log(`   📍 Step: 输入新名称 "${newName}" 并按 Enter...`);
  await inputNewName.call(this, newName, true);
});

// ============================================
// Then Steps
// ============================================

Then('该项名称应该更新为 {string}', async function (this: CustomWorld, expectedName: string) {
  console.log(`   📍 Step: 验证名称为 "${expectedName}"...`);

  await this.page.waitForTimeout(1000);
  const renamedItem = this.page.getByText(expectedName, { exact: true }).first();
  await expect(renamedItem).toBeVisible({ timeout: 5000 });

  console.log(`   ✅ 名称已更新为 "${expectedName}"`);
});

Then('Agent 应该显示置顶图标', async function (this: CustomWorld) {
  console.log('   📍 Step: 验证显示置顶图标...');

  await this.page.waitForTimeout(500);
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  // Pin icon uses lucide-react which adds class "lucide lucide-pin"
  const pinIcon = targetItem.locator('svg[class*="lucide-pin"]');
  await expect(pinIcon).toBeVisible({ timeout: 5000 });

  console.log('   ✅ 置顶图标已显示');
});

Then('Agent 不应该显示置顶图标', async function (this: CustomWorld) {
  console.log('   📍 Step: 验证不显示置顶图标...');

  await this.page.waitForTimeout(500);
  const targetItem = this.page.locator(this.testContext.targetItemSelector).first();
  // Pin icon uses lucide-react which adds class "lucide lucide-pin"
  const pinIcon = targetItem.locator('svg[class*="lucide-pin"]');
  await expect(pinIcon).not.toBeVisible({ timeout: 5000 });

  console.log('   ✅ 置顶图标未显示');
});

Then('Agent 应该从列表中移除', async function (this: CustomWorld) {
  console.log('   📍 Step: 验证 Agent 已移除...');

  await this.page.waitForTimeout(500);

  // Use unique selector based on agent ID (href) to avoid false positives
  // when multiple agents have the same name
  if (this.testContext.targetItemSelector) {
    const deletedItem = this.page.locator(this.testContext.targetItemSelector);
    await expect(deletedItem).not.toBeVisible({ timeout: 5000 });
  }

  console.log('   ✅ Agent 已从列表中移除');
});
