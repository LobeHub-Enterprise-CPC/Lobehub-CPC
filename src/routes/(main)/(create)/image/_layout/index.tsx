'use client';

import { useEffect } from 'react';

import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import GenerationLayout from '@/routes/(main)/(create)/features/GenerationLayout';
import { useImageStore } from '@/store/image';
import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import RegisterHotkeys from './RegisterHotkeys';
import Sidebar from './Sidebar';

const ImageLayout = () => {
  const { showAiImage } = useServerConfigStore(featureFlagsSelectors);
  const navigate = useWorkspaceAwareNavigate();

  useEffect(() => {
    if (!showAiImage) navigate('/video', { replace: true });
  }, [showAiImage, navigate]);

  if (!showAiImage) return null;

  return (
    <GenerationLayout extra={<RegisterHotkeys />} sidebar={<Sidebar />} useStore={useImageStore} />
  );
};

export default ImageLayout;
