import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthorizationConfirmCard from './AuthorizationConfirmCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'screen5.identity.organizationWithSlug' && options
        ? `${options.name}（${options.slug}）`
        : options
          ? `${key} ${Object.values(options).join(',')}`
          : key,
  }),
}));

vi.mock('./LobeMessage', () => ({
  default: ({ sentences }: { sentences: string[] }) => <div>{sentences.join(' ')}</div>,
}));

const NOW = new Date('2026-10-15T08:00:00Z').getTime();

const renderCard = (props: Partial<Parameters<typeof AuthorizationConfirmCard>[0]> = {}) => {
  const handlers = { onCancel: vi.fn(), onConfirm: vi.fn(), onSwitchOrganization: vi.fn() };
  render(
    <AuthorizationConfirmCard
      request={{
        account: 'li@acme.example',
        confirmationId: 'c1',
        entryUrl: 'https://work.example.com/orgs/acme',
        expiresAt: NOW + 90_000,
        generation: 'g1',
        name: 'Acme',
      }}
      {...handlers}
      {...props}
    />,
  );

  return handlers;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AuthorizationConfirmCard', () => {
  it('counts down to expiry and locks confirming once it is over', () => {
    const { onConfirm } = renderCard();

    expect(screen.getByText('screen5.confirm.remaining 1:30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'screen5.confirm.confirm' })).toBeEnabled();

    act(() => {
      vi.advanceTimersByTime(91_000);
    });

    expect(screen.getByText('screen5.confirm.expired')).toBeInTheDocument();
    expect(screen.queryByText(/screen5.confirm.remaining/)).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'screen5.confirm.confirm' });
    expect(confirm).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'screen5.confirm.switchOrganization' }),
    ).toBeDisabled();
    // Cancelling stays possible so the user can always leave the card.
    expect(screen.getByRole('button', { name: 'screen5.actions.cancel' })).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('locks every action while one reply is in flight', () => {
    renderCard({ busy: 'confirm' });

    expect(
      screen.getByRole('button', { name: 'screen5.confirm.switchOrganization' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'screen5.actions.cancel' })).toBeDisabled();
  });

  it('wires the three actions', () => {
    const { onCancel, onConfirm, onSwitchOrganization } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'screen5.confirm.confirm' }));
    fireEvent.click(screen.getByRole('button', { name: 'screen5.confirm.switchOrganization' }));
    fireEvent.click(screen.getByRole('button', { name: 'screen5.actions.cancel' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onSwitchOrganization).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('organization display', () => {
    const request = (extra: Record<string, unknown>) => ({
      account: 'li@acme.example',
      confirmationId: 'c1',
      entryUrl: 'https://work.example.com/orgs/acme',
      expiresAt: NOW + 90_000,
      generation: 'g1',
      ...extra,
    });

    it('shows the name with its slug', () => {
      renderCard({ request: request({ name: 'Acme', slug: 'acme' }) });

      expect(screen.getByText('Acme（acme）')).toBeInTheDocument();
    });

    it('shows only the name, only the slug, or no organization row', () => {
      renderCard({ request: request({ name: 'Acme' }) });
      expect(screen.getByText('Acme')).toBeInTheDocument();
      cleanup();

      renderCard({ request: request({ slug: 'acme' }) });
      expect(screen.getByText('acme')).toBeInTheDocument();
      cleanup();

      renderCard({ request: request({}) });
      expect(screen.queryByText('screen5.identity.organization')).not.toBeInTheDocument();
    });
  });

  describe('"choose another organization" entry', () => {
    const switchButton = () =>
      screen.queryByRole('button', { name: 'screen5.confirm.switchOrganization' });
    const request = (hasOtherOrganizations?: boolean) => ({
      account: 'li@acme.example',
      confirmationId: 'c1',
      entryUrl: 'https://work.example.com/orgs/acme',
      expiresAt: NOW + 90_000,
      generation: 'g1',
      ...(hasOtherOrganizations === undefined ? {} : { hasOtherOrganizations }),
    });

    it.each([
      ['true', true, true],
      ['false', false, false],
      ['unknown', undefined, true],
    ])('follows this login when it says %s', (_name, value, shown) => {
      renderCard({ request: request(value) });

      expect(!!switchButton()).toBe(shown);
    });

    it('still offers cancel and confirm when the switch entry is hidden', () => {
      renderCard({ request: request(false) });

      expect(screen.getByRole('button', { name: 'screen5.actions.cancel' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'screen5.confirm.confirm' })).toBeEnabled();
    });
  });
});
