import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startNewHomeChat } from './startNewHomeChat';

const mocks = vi.hoisted(() => ({
  focus: vi.fn(),
  setHomeSelectedProjectId: vi.fn(),
  updateSystemStatus: vi.fn(),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: { getState: () => ({ mainInputEditor: { focus: mocks.focus } }) },
}));
vi.mock('@/store/global', () => ({
  useGlobalStore: { getState: () => ({ updateSystemStatus: mocks.updateSystemStatus }) },
}));
vi.mock('@/store/home', () => ({
  useHomeStore: { getState: () => ({ setHomeSelectedProjectId: mocks.setHomeSelectedProjectId }) },
}));

describe('startNewHomeChat', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('opens Home with no project picked and focuses the composer', () => {
    const navigate = vi.fn();

    startNewHomeChat(navigate);

    expect(mocks.setHomeSelectedProjectId).toHaveBeenCalledWith(undefined);
    expect(mocks.updateSystemStatus).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
    // On Home already nothing remounts the composer, so focus is requested here.
    expect(mocks.focus).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(mocks.focus).toHaveBeenCalledTimes(1);
  });

  it('picks the given agent for the conversation', () => {
    startNewHomeChat(vi.fn(), 'agt_1');

    expect(mocks.updateSystemStatus).toHaveBeenCalledWith({ homeSelectedAgentId: 'agt_1' });
  });
});
