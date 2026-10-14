'use client';

import { SignInEmailSentStep } from './SignInEmailSentStep';
import { SignInEmailStep } from './SignInEmailStep';
import { SignInPasswordStep } from './SignInPasswordStep';
import { useSignIn } from './useSignIn';

const SignIn = () => {
  const {
    agreementChecked,
    continueWithAgreement,
    disableEmailPassword,
    email,
    enableMagicLink,
    form,
    handleBackFromSent,
    handleBackToEmail,
    handleForgotPassword,
    handleGoToSignup,
    handleResendEmail,
    handleSocialSignIn,
    isSocialOnly,
    lastAuthProvider,
    loading,
    oAuthSSOProviders,
    providerDetails,
    reloadSSO,
    sending,
    sessionExpired,
    sentInfo,
    serverConfigInit,
    setAgreementChecked,
    socialLoading,
    ssoError,
    step,
    tenantUnavailable,
  } = useSignIn();

  if (step === 'emailSent' && sentInfo)
    return (
      <SignInEmailSentStep
        email={sentInfo.email}
        sending={sending}
        type={sentInfo.type}
        onBack={handleBackFromSent}
        onResend={handleResendEmail}
      />
    );

  if (step === 'password' && !disableEmailPassword)
    return (
      <SignInPasswordStep
        email={email}
        forgotLoading={sending}
        form={form as any}
        loading={loading}
        onBackToEmail={handleBackToEmail}
        onForgotPassword={handleForgotPassword}
      />
    );

  return (
    <SignInEmailStep
      agreementChecked={agreementChecked}
      continueWithAgreement={continueWithAgreement}
      disableEmailPassword={disableEmailPassword}
      enableMagicLink={enableMagicLink}
      form={form as any}
      isSocialOnly={isSocialOnly}
      lastAuthProvider={lastAuthProvider}
      loading={loading}
      oAuthSSOProviders={oAuthSSOProviders}
      providerDetails={providerDetails}
      reloadSSO={reloadSSO}
      serverConfigInit={serverConfigInit}
      sessionExpired={sessionExpired}
      setAgreementChecked={setAgreementChecked}
      socialLoading={socialLoading}
      ssoError={ssoError}
      tenantUnavailable={tenantUnavailable}
      onGoToSignup={handleGoToSignup}
      onResetEmail={handleBackToEmail}
      onSetPassword={handleForgotPassword}
      onSocialSignIn={handleSocialSignIn}
    />
  );
};

export default SignIn;
