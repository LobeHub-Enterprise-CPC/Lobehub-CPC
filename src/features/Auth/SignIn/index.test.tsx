import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SignIn from './index';

vi.mock('./useSignIn', () => ({ useSignIn: () => ({ step: 'email' }) }));
vi.mock('./SignInEmailStep', () => ({
  SignInEmailStep: () => <form aria-label="Email sign in" />,
}));
vi.mock('./SignInEmailSentStep', () => ({ SignInEmailSentStep: () => null }));
vi.mock('./SignInPasswordStep', () => ({ SignInPasswordStep: () => null }));

describe('SignIn', () => {
  afterEach(() => vi.unstubAllGlobals());

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
