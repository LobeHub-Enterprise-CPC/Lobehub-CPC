import {
  BRANDING_EMAIL,
  CHANGELOG_ENABLED,
  LOBE_CHAT_CLOUD,
  UTM_SOURCE,
} from '@lobechat/business-const';
import { DOWNLOAD_URL, OFFICIAL_URL } from '@lobechat/const';
import {
  Book,
  CircleUserRound,
  Cloudy,
  Download,
  Feather,
  FileClockIcon,
  Settings2,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import useBusinessMeCells from '@/business/client/features/User/useBusinessMeCells';
import { type CellProps } from '@/components/Cell';
import { openChangelogModal } from '@/components/ChangelogModal';
import { DOCUMENTS, FEEDBACK } from '@/const/index';
import { isCustomBranding } from '@/const/version';
import { useDesktopDownload } from '@/features/Downloads/useDesktopDownload';
import { usePlatform } from '@/hooks/usePlatform';
import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

export const useCategory = () => {
  const navigate = useNavigate();
  const { t } = useTranslation(['common', 'setting', 'auth']);
  const { showCloudPromotion, hideDocs } = useServerConfigStore(featureFlagsSelectors);
  const [isLoginWithAuth] = useUserStore((s) => [authSelectors.isLoginWithAuth(s)]);
  const { isIOS, isAndroid } = usePlatform();
  const businessMeCells = useBusinessMeCells();
  const desktopDownload = useDesktopDownload();

  const downloadUrl = useMemo(() => {
    if (isIOS) return DOWNLOAD_URL.ios;
    if (isAndroid) return DOWNLOAD_URL.android;
    return DOWNLOAD_URL.default;
  }, [isIOS, isAndroid]);

  const profile: CellProps[] = [
    {
      icon: CircleUserRound,
      key: 'profile',
      label: t('userPanel.profile'),
      onClick: () => navigate('/me/profile'),
    },
  ];

  const settings: CellProps[] = [
    {
      icon: Settings2,
      key: 'setting',
      label: t('userPanel.setting'),
      onClick: () => navigate('/me/settings'),
    },
    {
      type: 'divider',
    },
  ];

  const getDesktopApp: CellProps[] =
    isCustomBranding && !desktopDownload.available
      ? []
      : [
          {
            icon: Download,
            key: 'get-desktop-app',
            label: t('getDesktopApp'),
            onClick: () =>
              window.open(isCustomBranding ? desktopDownload.href : downloadUrl, '__blank'),
          },
          {
            type: 'divider',
          },
        ];

  const helps: CellProps[] = [
    !isCustomBranding &&
      showCloudPromotion && {
        icon: Cloudy,
        key: 'cloud',
        label: t('userPanel.cloud', { name: LOBE_CHAT_CLOUD }),
        onClick: () => window.open(`${OFFICIAL_URL}?utm_source=${UTM_SOURCE}`, '__blank'),
      },
    !isCustomBranding && {
      icon: Book,
      key: 'docs',
      label: t('document'),
      onClick: () => window.open(DOCUMENTS, '__blank'),
    },
    (!isCustomBranding || BRANDING_EMAIL.support) && {
      icon: Feather,
      key: 'feedback',
      label: t('feedback'),
      onClick: () => window.open(FEEDBACK, '__blank'),
    },
    !isCustomBranding &&
      CHANGELOG_ENABLED && {
        icon: FileClockIcon,
        key: 'changelog',
        label: t('changelog'),
        onClick: () => openChangelogModal(),
      },
  ].filter(Boolean) as CellProps[];

  const mainItems = [
    {
      type: 'divider',
    },
    ...(isLoginWithAuth ? profile : []),
    ...(isLoginWithAuth ? settings : []),
    ...(isLoginWithAuth ? businessMeCells : []),
    ...getDesktopApp,
    ...(isCustomBranding || !hideDocs ? helps : []),
  ].filter(Boolean) as CellProps[];

  return mainItems;
};
