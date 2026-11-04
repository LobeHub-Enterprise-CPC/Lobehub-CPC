import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  heterogeneous: false,
  placePicker: true,
  runtime: true,
}));

vi.mock('../../hooks/useAgentId', () => ({ useAgentId: () => 'agt_1' }));
vi.mock('../../hooks/useChatInputResourceAccess', () => ({
  useChatInputResourceAccess: () => ({ canConfigureResource: true }),
}));
vi.mock('../../hooks/useEffectiveAgentMode', () => ({
  useEffectiveAgentMode: () => ({ isAgentRuntimeMode: state.runtime }),
}));
vi.mock('../../ControlBar/executionPlace/useAgentPlacePicker', () => ({
  useAgentPlacePicker: () => ({ enabled: state.placePicker }),
}));
vi.mock('../../ControlBar/DeviceSwitcher', () => ({
  default: () => <div data-testid={'device-switcher'} />,
}));
vi.mock('../../ControlBar/executionPlace/ExecutionPlacePicker', () => ({
  ExecutionPlacePicker: ({ showLabel }: { showLabel?: boolean }) => (
    <div data-show-label={String(showLabel)} data-testid={'place-picker'} />
  ),
}));
vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (state: object) => unknown) => selector({}),
}));
vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: { isAgentHeterogeneousById: () => () => state.heterogeneous },
}));

const { default: ExecutionDevice } = await import('./index');

beforeEach(() => {
  Object.assign(state, { heterogeneous: false, placePicker: true, runtime: true });
});

describe('ExecutionDevice action', () => {
  it('names the place, since it sits among labelled controls', () => {
    render(<ExecutionDevice />);

    expect(screen.getByTestId('place-picker')).toHaveAttribute('data-show-label', 'true');
  });

  it('keeps the device switcher for a project-bound conversation', () => {
    state.placePicker = false;
    render(<ExecutionDevice />);

    expect(screen.getByTestId('device-switcher')).toBeInTheDocument();
  });

  it('renders nothing for a chat-only model', () => {
    state.runtime = false;
    const { container } = render(<ExecutionDevice />);

    expect(container).toBeEmptyDOMElement();
  });

  it('leaves a heterogeneous agent to its own control bar', () => {
    state.heterogeneous = true;
    const { container } = render(<ExecutionDevice />);

    expect(container).toBeEmptyDOMElement();
  });
});
