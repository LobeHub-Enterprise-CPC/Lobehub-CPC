import { describe, expect, it } from 'vitest';

import { renderTenantRequiredPage } from '../tenantRequiredPage';

describe('renderTenantRequiredPage', () => {
  it('renders the same static page for every visitor, in their language', () => {
    const en = renderTenantRequiredPage('en-US,en;q=0.9');
    const zh = renderTenantRequiredPage('zh-CN,zh;q=0.9');
    expect(en).toContain('<html lang="en-US">');
    expect(zh).toContain('<html lang="zh-CN">');
    expect(zh).toContain('请通过专属地址访问');
    expect(renderTenantRequiredPage(null)).toBe(en);
  });

  it('makes no request and names no tenant concept', () => {
    const html = renderTenantRequiredPage('zh-CN') + renderTenantRequiredPage('en');
    expect(html).not.toMatch(/<script|<link|<img|fetch\(|src=/i);
    expect(html).not.toMatch(/tenant|租户/i);
  });
});
