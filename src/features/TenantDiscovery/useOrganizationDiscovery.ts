import { useForm } from '@lobehub/ui/form';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EMAIL_REGEX } from '@/features/Auth/SignIn/emailRegex';
import { useAuthAgreement } from '@/features/AuthShell/AuthAgreement';

import {
  type DiscoveredOrganization,
  discoverOrganizations,
  OrganizationLookupError,
  selectOrganization,
  withLanguage,
} from './api';
import { type DesktopFlow, readDesktopFlow } from './desktopFlow';

const EMAIL_MAX_LENGTH = 254;

export interface DiscoveryNotice {
  text: string;
}

interface DiscoveryFormValues {
  email: string;
}

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export const useOrganizationDiscovery = (initialDesktopFlow?: DesktopFlow) => {
  // Fixed for the life of the page: the request that opened it does not change.
  const [desktopFlow] = useState<DesktopFlow>(() => initialDesktopFlow ?? readDesktopFlow());
  const desktopParams = desktopFlow.kind === 'active' ? desktopFlow.params : undefined;
  const [handoffExpired, setHandoffExpired] = useState(false);
  const { i18n, t } = useTranslation('auth');
  const { agreementChecked, continueWithAgreement, setAgreementChecked } = useAuthAgreement();
  const [organizations, setOrganizations] = useState<DiscoveredOrganization[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [unavailableIds, setUnavailableIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<DiscoveryNotice | null>(null);

  // A ref, not state: two submits in the same tick must not both see "idle".
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // The address the organizations were found for; select must carry the same one.
  const emailRef = useRef('');

  const failureNotice = useCallback(
    (error: unknown): DiscoveryNotice => {
      if (error instanceof OrganizationLookupError) {
        if (error.code === 'rateLimited')
          return {
            text: error.retryAfter
              ? t('organization.discovery.rateLimited', { seconds: error.retryAfter })
              : t('organization.discovery.rateLimitedGeneric'),
          };
        if (error.code === 'notAvailable')
          return { text: t('organization.discovery.notAvailable') };
        if (error.code === 'invalidEmail')
          return { text: t('organization.discovery.emailInvalid') };
      }
      return { text: t('organization.discovery.unavailable') };
    },
    [t],
  );

  // The caller holds `busyRef`. Success leaves every control locked on purpose: the page is
  // about to be replaced, and handing the button back before that would flash the form.
  const startSelection = useCallback(
    async (organization: DiscoveredOrganization) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setNotice(null);
      setSelectingId(organization.id);
      try {
        const url = await selectOrganization(
          { desktop: desktopParams, email: emailRef.current || undefined, id: organization.id },
          controller.signal,
        );
        // A sign-in page may sit on a custom domain that has never seen this browser's
        // language; a desktop authorization URL is followed exactly as the server built it.
        window.location.assign(desktopParams ? url : withLanguage(url, i18n.language));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof OrganizationLookupError && error.code === 'handoffExpired') {
          // This request can never succeed again; the only way on is the client's.
          setHandoffExpired(true);
          setPickerOpen(false);
          setNotice(null);
        } else {
          if (error instanceof OrganizationLookupError && error.code === 'notAvailable')
            setUnavailableIds((previous) => new Set(previous).add(organization.id));
          setNotice(failureNotice(error));
        }
        busyRef.current = false;
        setSelectingId(null);
      }
    },
    [desktopParams, failureNotice, i18n.language],
  );

  const choose = useCallback(
    (organization: DiscoveredOrganization) => {
      if (busyRef.current) return;
      busyRef.current = true;
      void startSelection(organization);
    },
    [startSelection],
  );

  const lookUp = async (values: DiscoveryFormValues) => {
    if (busyRef.current) return;
    const email = normalizeEmail(values.email);
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    emailRef.current = email;
    setNotice(null);
    setUnavailableIds(new Set());
    setSearching(true);
    try {
      const found = await discoverOrganizations(email, controller.signal);
      if (controller.signal.aborted) return;

      if (found.length === 1) {
        // Hand the busy state straight to the selection: the button never leaves loading.
        setSearching(false);
        await startSelection(found[0]);
        return;
      }
      if (found.length === 0) {
        form.setErrors({ email: t('organization.discovery.notFound') });
      } else {
        setOrganizations(found);
        setPickerOpen(true);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof OrganizationLookupError && error.code === 'invalidEmail')
        form.setErrors({ email: t('organization.discovery.emailInvalid') });
      else setNotice(failureNotice(error));
    }
    busyRef.current = false;
    setSearching(false);
  };

  const form = useForm<DiscoveryFormValues>({
    initialValues: { email: '' },
    // Same gate as the sign-in page: the terms are accepted once, here or there.
    onSubmit: (values) => continueWithAgreement(() => void lookUp(values)),
  });

  const validateEmail = useCallback(
    (value: string) => {
      const email = normalizeEmail(value ?? '');
      if (!email) return t('organization.discovery.emailRequired');
      if (email.length > EMAIL_MAX_LENGTH || !EMAIL_REGEX.test(email))
        return t('organization.discovery.emailInvalid');
      return undefined;
    },
    [t],
  );

  const closePicker = useCallback(() => {
    // Picking is in flight: the only way out is the navigation it started.
    if (selectingId) return;
    setPickerOpen(false);
    setNotice(null);
  }, [selectingId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Coming back through the browser's back/forward cache restores this page as it was
  // left, mid-selection; the navigation is over, so hand the controls back.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      busyRef.current = false;
      setSearching(false);
      setSelectingId(null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // A desktop sign-in that cannot proceed here is restarted from the client, not retried.
  const blocked: 'expired' | 'invalid' | null =
    desktopFlow.kind === 'blocked' ? desktopFlow.reason : handoffExpired ? 'expired' : null;

  return {
    agreementChecked,
    blocked,
    desktopFlow,
    choose,
    closePicker,
    dismissNotice: () => setNotice(null),
    form,
    notice,
    organizations,
    pickerOpen,
    searching,
    selectingId,
    setAgreementChecked,
    unavailableIds,
    validateEmail,
  };
};
