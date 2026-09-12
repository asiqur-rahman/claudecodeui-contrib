import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';
import UnlockScreen from '@/modules/auth/UnlockScreen';

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup/login/unlock and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, authMode, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (authMode === 'account') {
    if (needsSetup) {
      return <SetupForm />;
    }

    if (!user) {
      return <LoginForm />;
    }
  } else if (authMode === 'shared-password' && !user) {
    return <UnlockScreen />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
