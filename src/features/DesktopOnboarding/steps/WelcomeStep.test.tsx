import { ConfigProvider } from '@lobehub/ui';
import { en } from '@lobehub/ui/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import WelcomeStep from './WelcomeStep';

vi.mock('@lobehub/ui/awesome', () => ({ TypewriterEffect: () => null }));
vi.mock('@/components/Branding', () => ({ ProductLogo: () => null }));

const originalUserState = useUserStore.getState();
afterEach(() => {
  cleanup();
  useUserStore.setState(originalUserState);
});

describe('desktop Welcome before organization sign-in', () => {
  it.each([true, false])(
    'continues without writing the existing telemetry=%s preference',
    (telemetry) => {
      const updateGeneralConfig = vi.fn().mockResolvedValue(undefined);
      useUserStore.setState({ settings: { general: { telemetry } }, updateGeneralConfig });
      const onNext = vi.fn();
      render(
        <ConfigProvider locale={'en'} motion={motion} resources={en}>
          <WelcomeStep onNext={onNext} />
        </ConfigProvider>,
      );

      fireEvent.click(screen.getByRole('button'));

      expect(onNext).toHaveBeenCalledOnce();
      expect(updateGeneralConfig).not.toHaveBeenCalled();
      expect(useUserStore.getState().settings.general?.telemetry).toBe(telemetry);
    },
  );
});
