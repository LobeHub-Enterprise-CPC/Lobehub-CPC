import { initializeTenant, setRemoteAppAddress } from '@lobechat/business-tenant/client';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AcceptanceShare from './AcceptanceShare';

const menu = vi.hoisted(() => ({ items: [] as Array<{ key: string; onClick: () => unknown }> }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Button: ({ children }: { children: unknown }) => children,
  confirmModal: vi.fn(),
  DropdownMenu: ({ children, items }: { children: unknown; items: typeof menu.items }) => {
    menu.items = items;
    return children;
  },
  toast,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/libs/swr', () => ({ mutate: vi.fn() }));
vi.mock('@/services/verify', () => ({ verifyService: {} }));
vi.mock('../AcceptanceScope', () => ({ useAcceptanceScope: () => ({ acceptanceId: 'acc_1' }) }));
vi.mock('../useAcceptanceBundle', () => ({
  useAcceptanceBundle: () => ({ data: { acceptance: { visibility: 'private' } }, mutate: vi.fn() }),
}));
vi.mock('../visibility', () => ({ canReviewAcceptance: () => true }));

const copiedLink = async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<AcceptanceShare />);
  await menu.items.find((item) => item.key === 'copy')!.onClick();
  return writeText.mock.calls[0]?.[0];
};

afterEach(() => {
  setRemoteAppAddress(undefined);
  initializeTenant(new URL(window.location.href));
});

describe('AcceptanceShare copy link', () => {
  it('keeps the tenant path of the page, so the link does not land on organization discovery', async () => {
    initializeTenant(new URL(`${window.location.origin}/t/acme/acceptance/acc_1`));

    await expect(copiedLink()).resolves.toBe(`${window.location.origin}/t/acme/acceptance/acc_1`);
  });

  it('uses the remote tenant address in the desktop renderer, not an app:// origin', async () => {
    setRemoteAppAddress('https://host.example/t/acme');

    await expect(copiedLink()).resolves.toBe('https://host.example/t/acme/acceptance/acc_1');
  });
});
