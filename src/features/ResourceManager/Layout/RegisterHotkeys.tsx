'use client';

import { useLibraryPermission } from '@/features/EnterpriseKnowledge/useLibraryPermission';
import { useRegisterFilesHotkeys } from '@/hooks/useHotkeys';

const EnabledHotkeys = () => {
  useRegisterFilesHotkeys();
  return null;
};

const RegisterHotkeys = () => {
  const { allowed } = useLibraryPermission('edit_own_content');
  return allowed ? <EnabledHotkeys /> : null;
};
export default RegisterHotkeys;
