import { afterEach, describe, expect, it } from 'vitest';

import {
  parseDesktopHandoffParams,
  readDesktopFlowStatus,
  resolveDesktopFlow,
} from './desktopFlow';

const STATE = '0123456789abcdef0123456789abcdef';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const valid = `?client=desktop&state=${STATE}&code_challenge=${CHALLENGE}`;

describe('parseDesktopHandoffParams', () => {
  it('accepts a 32-char lowercase hex state and a 43-char base64url challenge', () => {
    expect(parseDesktopHandoffParams(valid)).toEqual({ codeChallenge: CHALLENGE, state: STATE });
  });

  it.each([
    ['uppercase hex state', valid.replace(STATE, STATE.toUpperCase())],
    ['short state', valid.replace(STATE, STATE.slice(1))],
    ['non-hex state', valid.replace(STATE, 'g'.repeat(32))],
    ['short challenge', valid.replace(CHALLENGE, CHALLENGE.slice(1))],
    ['challenge with padding', valid.replace(CHALLENGE, `${CHALLENGE.slice(1)}=`)],
    [
      'challenge with a standard-base64 character',
      valid.replace(CHALLENGE, `${CHALLENGE.slice(1)}+`),
    ],
    ['missing state', `?code_challenge=${CHALLENGE}`],
    ['missing challenge', `?state=${STATE}`],
    ['nothing', ''],
  ])('rejects %s', (_, search) => {
    expect(parseDesktopHandoffParams(search)).toBeNull();
  });
});

describe('resolveDesktopFlow', () => {
  const params = { codeChallenge: CHALLENGE, state: STATE };

  it('treats a page without a desktop flow as an ordinary visit', () => {
    expect(resolveDesktopFlow(null, valid)).toEqual({ kind: 'none' });
  });

  it('ready: active with the parameters from the URL', () => {
    expect(resolveDesktopFlow('ready', valid)).toEqual({
      fastPathUnavailable: false,
      kind: 'active',
      params,
    });
  });

  it('unavailable: active too, flagged so the page can say the instant jump failed', () => {
    expect(resolveDesktopFlow('unavailable', valid)).toEqual({
      fastPathUnavailable: true,
      kind: 'active',
      params,
    });
  });

  it.each(['ready', 'unavailable'] as const)(
    '%s with parameters the page cannot vouch for is invalid',
    (status) => {
      expect(resolveDesktopFlow(status, '?client=desktop&state=zz&code_challenge=zz')).toEqual({
        kind: 'blocked',
        reason: 'invalid',
      });
    },
  );

  it('invalid and expired hide the form, whatever the URL holds', () => {
    expect(resolveDesktopFlow('invalid', valid)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(resolveDesktopFlow('expired', valid)).toEqual({ kind: 'blocked', reason: 'expired' });
  });

  it('an unrecognised status is treated as invalid', () => {
    expect(resolveDesktopFlow('unknown', valid)).toEqual({ kind: 'blocked', reason: 'invalid' });
  });
});

describe('readDesktopFlowStatus', () => {
  const setConfig = (value: unknown) =>
    Object.defineProperty(window, '__SERVER_CONFIG__', {
      configurable: true,
      value,
      writable: true,
    });

  afterEach(() => setConfig(undefined));

  it('is null when the server injected no desktop flow', () => {
    setConfig({});
    expect(readDesktopFlowStatus()).toBeNull();
    setConfig(undefined);
    expect(readDesktopFlowStatus()).toBeNull();
  });

  it('returns a known status, and "unknown" for anything else', () => {
    setConfig({ desktopFlow: { status: 'unavailable' } });
    expect(readDesktopFlowStatus()).toBe('unavailable');
    setConfig({ desktopFlow: { status: 'weird' } });
    expect(readDesktopFlowStatus()).toBe('unknown');
    setConfig({ desktopFlow: {} });
    expect(readDesktopFlowStatus()).toBe('unknown');
  });
});
