/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { UsageLog } from '@/types/usage/usageRecord';

import { GroupBy } from '../../../../types';
import ActiveModels from './index';

vi.mock('@/components/LobeIcons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span>{model}</span>,
}));

// Stubbed for the same reason as the vendor icons above: the real one reaches
// the branding logo, and through it `@lobehub/ui/brand`, which this file's
// deliberately narrow `@lobehub/icons` stub cannot satisfy.
vi.mock('@/components/Branding', () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span>{provider}</span>,
}));

vi.mock('@lobehub/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  return {
    ...actual,
    Avatar: ({ avatar, title }: { avatar?: string | null; title?: string }) => (
      <span aria-label={title} data-testid="active-user-avatar">
        {avatar}
      </span>
    ),
  };
});

// The real modal animates in through a portal; render the table it hosts as soon
// as it is open.
vi.mock('@/components/ImperativeModal', () => ({
  default: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('@/components/StatisticCard', () => ({
  default: ({
    extra,
    statistic,
  }: {
    extra?: ReactNode;
    statistic: { description?: ReactNode; value?: ReactNode };
  }) => (
    <div>
      {extra}
      <span>{statistic.value}</span>
      {statistic.description}
    </div>
  ),
}));

vi.mock('@/components/StatisticCard/TitleWithPercentage', () => ({
  default: ({ title }: { title: string }) => <span>{title}</span>,
}));

const usageLog: UsageLog[] = [
  {
    date: 1,
    day: '2026-05-27',
    records: [
      {
        createdAt: new Date('2026-05-27T00:00:00.000Z'),
        id: 'record-1',
        model: 'gpt-5-mini',
        provider: 'openai',
        spend: 1,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalTokens: 30,
        type: 'chat',
        updatedAt: new Date('2026-05-27T00:00:00.000Z'),
        userId: 'user-1',
      },
    ],
    totalRequests: 1,
    totalSpend: 1,
    totalTokens: 30,
  },
];

describe('ActiveModels', () => {
  it('uses the resolved user name as the avatar fallback when the user has no avatar URL', () => {
    render(
      <ActiveModels
        data={usageLog}
        groupBy={GroupBy.User}
        resolveUser={() => ({ avatar: null, name: 'Ada Lovelace' })}
      />,
    );

    expect(screen.getByTestId('active-user-avatar')).toHaveTextContent('Ada Lovelace');
  });

  // A provider row reads as the provider's name, never its id — for the branded
  // provider the id is the upstream `lobehub`.
  // The table lives in the modal the card's maximize button opens.
  const openTable = () => fireEvent.click(screen.getAllByRole('button')[0]);

  it('names the provider of a provider row', async () => {
    render(<ActiveModels data={usageLog} groupBy={GroupBy.Provider} />);
    openTable();

    expect((await screen.findAllByText('OpenAI')).length).toBeGreaterThan(0);
  });

  it("names the provider in a model's provider rows", async () => {
    render(<ActiveModels data={usageLog} groupBy={GroupBy.Model} />);
    openTable();

    expect((await screen.findAllByText('OpenAI')).length).toBeGreaterThan(0);
  });
});
