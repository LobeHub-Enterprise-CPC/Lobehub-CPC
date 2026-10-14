import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SignIn from './index';

const signInState = vi.hoisted(() => ({ step: 'email', disableEmailPassword: false }));
vi.mock('./useSignIn', () => ({ useSignIn: () => signInState }));
vi.mock('./SignInEmailStep', () => ({
  SignInEmailStep: () => <form aria-label="Email sign in" />,
}));
vi.mock('./SignInEmailSentStep', () => ({ SignInEmailSentStep: () => null }));
vi.mock('./SignInPasswordStep', () => ({
  SignInPasswordStep: () => <form aria-label="Password sign in" />,
}));

describe('SignIn', () => {
  beforeEach(() => {
    signInState.step = 'email';
    signInState.disableEmailPassword = false;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns to email entry when password login is disabled on the password step', () => {
    signInState.step = 'password';
    signInState.disableEmailPassword = true;
    render(<SignIn />);
    expect(screen.queryByRole('form', { name: 'Password sign in' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Email sign in' })).toBeTruthy();
  });

  it('opens the email form without making unsolicited credential requests', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);

    await act(async () => {
      render(<SignIn />);
    });

    expect(screen.getByRole('form', { name: 'Email sign in' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
