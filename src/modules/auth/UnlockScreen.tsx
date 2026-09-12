import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

/**
 * Password-only unlock screen for shared-password mode (no username).
 * Rendered by ProtectedRoute when the installation has password protection
 * enabled and no session exists yet.
 */
export default function UnlockScreen() {
  const { t } = useTranslation('auth');
  const { error: sessionError, unlockWithPassword } = useAuth();

  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (!password) {
        setErrorMessage(t('unlock.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await unlockWithPassword(password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [password, t, unlockWithPassword],
  );

  return (
    <AuthScreenLayout
      title={t('unlock.title')}
      description={t('unlock.description')}
      footerText={t('unlock.footerText')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="password"
          label={t('unlock.password')}
          value={password}
          onChange={setPassword}
          placeholder={t('unlock.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('unlock.loading')}
            </>
          ) : (
            t('unlock.submit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
