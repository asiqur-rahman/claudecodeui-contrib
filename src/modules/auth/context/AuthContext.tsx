import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { api, readApiErrorMessage } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, getAuthTokenRefreshDelay, isValidRefreshedToken, storeAuthToken } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  registrationFailed: 'errors.registrationFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
} as const;

type AuthActionResult = { success: true } | { success: false; error: string };

type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
};

type AuthMode = 'account' | 'shared-password' | 'none';

type AuthStatusPayload = {
  needsSetup?: boolean;
  authMode?: AuthMode;
};

type AuthUserPayload = {
  user?: AuthUser;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  authMode: AuthMode;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
  unlockWithPassword: (password: string) => Promise<AuthActionResult>;
  enableSecurity: (password: string, currentPassword?: string) => Promise<AuthActionResult>;
  disableSecurity: () => Promise<AuthActionResult>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  storeAuthToken(token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Defaults to the strictest mode while status is still loading (mirrors the
  // server's fail-closed default for a missing/unreadable auth_mode value).
  const [authMode, setAuthMode] = useState<AuthMode>('account');

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (IS_PLATFORM || !token || !user) {
      return;
    }

    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (isValidRefreshedToken(payload?.token)) {
        setToken(payload.token);
        persistToken(payload.token);
      }
    } catch (caughtError) {
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (isValidRefreshedToken(nextToken)) {
        setToken(nextToken);
      }
    };
    const handleSessionExpired = () => {
      clearSession();
      setError(t(AUTH_ERROR_MESSAGES.sessionExpired));
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [clearSession, t]);

  // The startup check below needs `t` only for its failure message.
  // react-i18next gives `t` a new identity on every language change, so
  // depending on it would re-run that check - and swap the whole app for the
  // loading screen - whenever the language changes, including when sign-in
  // adopts the language saved on another device.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);
      const mode: AuthMode = statusPayload?.authMode === 'shared-password' || statusPayload?.authMode === 'none'
        ? statusPayload.authMode
        : 'account';
      setAuthMode(mode);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      // Read the stored token rather than the `token` state: this bootstrap
      // flips `isLoading`, which swaps the whole app for the loading screen, so
      // it must run once on mount and not again on every X-Refreshed-Token
      // rotation (each one remounted the workspace, #1269).
      let activeToken = readStoredToken();

      // Open installs never show a login screen - the client silently mints
      // its own session the first time it learns protection is off.
      if (mode === 'none' && !activeToken) {
        const sessionResponse = await api.auth.session();
        const sessionPayload = await parseJsonSafely<AuthSessionPayload>(sessionResponse);
        if (sessionResponse.ok && sessionPayload?.token && sessionPayload.user) {
          setSession(sessionPayload.user, sessionPayload.token);
          activeToken = sessionPayload.token;
        }
      }

      if (!activeToken) {
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(tRef.current(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, setSession]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession, token, user]);

  // ProtectedRoute shows the workspace as soon as there is a user, so the
  // onboarding status is settled before the user is published; otherwise a
  // user who still has to onboard would see the workspace mount for a whole
  // round trip before Onboarding replaced it. The token is stored first
  // because that request reads it from storage.
  const publishSession = useCallback(async (nextUser: AuthUser, nextToken: string) => {
    persistToken(nextToken);
    await checkOnboardingStatus();
    setUser(nextUser);
    setToken(nextToken);
    setNeedsSetup(false);
  }, [checkOnboardingStatus]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          // Most auth failures arrive as the structured AppError envelope; passing its
          // `error` object on would render it as a React child and blank the screen.
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  const logout = useCallback(() => {
    // JWT logout is client-side: the server endpoint does not maintain a
    // revocation list, so clearing the session is the complete operation.
    clearSession();
  }, [clearSession]);

  const unlockWithPassword = useCallback<AuthContextValue['unlockWithPassword']>(
    async (password) => {
      try {
        setError(null);
        const response = await api.auth.unlock(password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Unlock error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [checkOnboardingStatus, setSession, t],
  );

  const enableSecurity = useCallback<AuthContextValue['enableSecurity']>(
    async (password, currentPassword) => {
      try {
        setError(null);
        const response = await api.auth.enableSecurity(password, currentPassword);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setAuthMode('shared-password');
        return { success: true };
      } catch (caughtError) {
        console.error('Enable security error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [setSession, t],
  );

  const disableSecurity = useCallback<AuthContextValue['disableSecurity']>(
    async () => {
      try {
        setError(null);
        const response = await api.auth.disableSecurity();
        const payload = await parseJsonSafely<unknown>(response);

        if (!response.ok) {
          const message = readApiErrorMessage(payload) ?? t(AUTH_ERROR_MESSAGES.networkError);
          setError(message);
          return { success: false, error: message };
        }

        setAuthMode('none');
        // The token just held is now revoked server-side (the epoch moved);
        // silently mint a fresh open-mode session so the app keeps working.
        const sessionResponse = await api.auth.session();
        const sessionPayload = await parseJsonSafely<AuthSessionPayload>(sessionResponse);
        if (sessionResponse.ok && sessionPayload?.token && sessionPayload.user) {
          setSession(sessionPayload.user, sessionPayload.token);
        } else {
          clearSession();
        }
        return { success: true };
      } catch (caughtError) {
        console.error('Disable security error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [clearSession, setSession, t],
  );

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      authMode,
      login,
      register,
      logout,
      refreshOnboardingStatus,
      unlockWithPassword,
      enableSecurity,
      disableSecurity,
    }),
    [
      authMode,
      disableSecurity,
      enableSecurity,
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      unlockWithPassword,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
