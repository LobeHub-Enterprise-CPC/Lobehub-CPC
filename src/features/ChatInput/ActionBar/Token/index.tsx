import { type PropsWithChildren } from 'react';
import { memo } from 'react';

import dynamic from '@/libs/next/dynamic';
import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import { useShowContextWindow } from './useShowContextWindow';

const LargeTokenContent = dynamic(() => import('./TokenTag'), { ssr: false });

const Token = memo<PropsWithChildren>(({ children }) => {
  const showTag = useShowContextWindow();

  return showTag && children;
});

const ContextWindow = () => {
  const showTokenCounter = useServerConfigStore((s) => featureFlagsSelectors(s).showTokenCounter);

  if (!showTokenCounter) return null;

  return (
    <Token>
      <LargeTokenContent />
    </Token>
  );
};

export default ContextWindow;
