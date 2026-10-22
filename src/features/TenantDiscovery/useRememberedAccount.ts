import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AccountRequestError,
  fetchRememberedAccount,
  forgetRememberedAccount,
  type RememberedAccount,
  selectRememberedOrganization,
} from './accountApi';
import { type DiscoveredOrganization } from './api';

export interface AccountNotice {
  kind: 'notAvailable' | 'rateLimited' | 'retryable';
}

export type AccountStatus = 'fallback' | 'loading' | 'ready';

/**
 * The remembered-account confirm card: load the account once, then let the user continue
 * into one of its organizations or forget it and sign in with another account.
 *
 * `fallback` means there is no remembered account (or it is gone): the caller renders the
 * ordinary finder form in place instead. Everything else stays inside the same card.
 */
export const useRememberedAccount = () => {
  const [status, setStatus] = useState<AccountStatus>('loading');
  const [account, setAccount] = useState<RememberedAccount | null>(null);
  const [notice, setNotice] = useState<AccountNotice | null>(null);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [unavailableIds, setUnavailableIds] = useState<ReadonlySet<string>>(new Set());

  // A ref, not state: two submits in the same tick must not both see "idle".
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // The notice carries only the failure's meaning; the card translates it, so this
  // callback never depends on the translator and the load effect runs once per mount.
  const failureNotice = useCallback((error: unknown): AccountNotice => {
    if (error instanceof AccountRequestError && error.code === 'rateLimited')
      return { kind: 'rateLimited' };
    if (error instanceof AccountRequestError && error.code === 'notAvailable')
      return { kind: 'notAvailable' };
    return { kind: 'retryable' };
  }, []);

  const load = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading');
    setNotice(null);
    setRetryIn(null);
    try {
      const remembered = await fetchRememberedAccount(controller.signal);
      if (controller.signal.aborted) return;
      setAccount(remembered);
      setUnavailableIds(new Set());
      setStatus('ready');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof AccountRequestError && error.code === 'empty') {
        // No remembered account: the finder form takes over, in place, without a reload.
        setStatus('fallback');
        return;
      }
      setStatus('ready');
      setAccount(null);
      if (error instanceof AccountRequestError && error.code === 'rateLimited' && error.retryAfter)
        setRetryIn(error.retryAfter);
      setNotice(failureNotice(error));
    }
  }, [failureNotice]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Coming back through the browser's back/forward cache restores this page as it was
  // left, mid-selection; the navigation is over, so hand the controls back.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      busyRef.current = false;
      setSelectingId(null);
      setLeaving(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // A rate limit disables every action until its seconds elapse; the card renders the
  // countdown from `retryIn`. When the seconds run out the alert stays, but the retry
  // action is handed back.
  useEffect(() => {
    if (retryIn === null) return;
    if (retryIn <= 0) {
      setRetryIn(null);
      return;
    }
    const timer = setTimeout(() => setRetryIn(retryIn - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryIn]);

  const choose = useCallback(
    async (organization: DiscoveredOrganization) => {
      if (busyRef.current || retryIn !== null) return;
      busyRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setNotice(null);
      setSelectingId(organization.id);
      try {
        const url = await selectRememberedOrganization(organization.id, controller.signal);
        // The server built an entry URL for this organization; follow it exactly.
        window.location.href = url;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof AccountRequestError && error.code === 'empty') {
          // The remembered account is gone; the finder form takes over.
          setStatus('fallback');
          setAccount(null);
        } else {
          if (error instanceof AccountRequestError && error.code === 'notAvailable')
            setUnavailableIds((previous) => new Set(previous).add(organization.id));
          if (
            error instanceof AccountRequestError &&
            error.code === 'rateLimited' &&
            error.retryAfter
          )
            setRetryIn(error.retryAfter);
          setNotice(failureNotice(error));
        }
        busyRef.current = false;
        setSelectingId(null);
      }
    },
    [failureNotice, retryIn],
  );

  const useAnotherAccount = useCallback(async () => {
    if (busyRef.current || retryIn !== null) return;
    busyRef.current = true;
    setLeaving(true);
    try {
      // The navigation happens whether forgetting succeeded or not.
      await forgetRememberedAccount();
    } finally {
      window.location.href = '/?switch=1';
    }
  }, [retryIn]);

  const lastUsed =
    account?.lastTenantId === null
      ? null
      : (account?.organizations.find((organization) => organization.id === account?.lastTenantId) ??
        null);
  const others = (account?.organizations ?? []).filter(
    (organization) => organization.id !== lastUsed?.id,
  );

  const busy = selectingId !== null || leaving;
  const locked = busy || retryIn !== null;

  return {
    account,
    busy,
    choose,
    lastUsed,
    leaving,
    locked,
    notice,
    others,
    retry: load,
    retryIn,
    selectingId,
    status,
    unavailableIds,
    useAnotherAccount,
  };
};
