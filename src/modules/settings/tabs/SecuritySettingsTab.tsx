import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { useAuth } from '@/modules/auth';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type PendingAction = 'idle' | 'enabling' | 'confirmingDisable';

/** Rendered by Settings for the "security" tab, toggling the shared-password lock. */
export default function SecuritySettingsTab() {
  const { t } = useTranslation('settings');
  const { authMode, enableSecurity, disableSecurity } = useAuth();

  const [pendingAction, setPendingAction] = useState<PendingAction>('idle');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  const resetFields = () => {
    setNewPassword('');
    setConfirmPassword('');
    setCurrentPassword('');
  };

  const handleEnable = async () => {
    setError(null);
    if (newPassword.length < 6) {
      setError(t('security.errors.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('security.errors.passwordMismatch'));
      return;
    }

    setIsSaving(true);
    const result = await enableSecurity(newPassword);
    setIsSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    resetFields();
    setPendingAction('idle');
  };

  const handleChangePassword = async () => {
    setError(null);
    setSuccessMessage(null);
    if (!currentPassword) {
      setError(t('security.errors.currentPasswordRequired'));
      return;
    }
    if (newPassword.length < 6) {
      setError(t('security.errors.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('security.errors.passwordMismatch'));
      return;
    }

    setIsSaving(true);
    const result = await enableSecurity(newPassword, currentPassword);
    setIsSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    resetFields();
    setSuccessMessage(t('security.changePasswordSuccess'));
  };

  const handleDisable = async () => {
    setError(null);
    setIsSaving(true);
    const result = await disableSecurity();
    setIsSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setPendingAction('idle');
  };

  if (authMode === 'account') {
    return (
      <div className="space-y-8">
        <SettingsSection title={t('security.sectionTitle')} description={t('security.sectionDescription')}>
          <SettingsCard>
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('security.accountModeNote')}</p>
          </SettingsCard>
        </SettingsSection>
      </div>
    );
  }

  const isEnabled = authMode === 'shared-password';

  return (
    <div className="space-y-8">
      <SettingsSection title={t('security.sectionTitle')} description={t('security.sectionDescription')}>
        <SettingsCard divided>
          <SettingsRow label={t('security.enableLabel')} description={t('security.enableDescription')}>
            <SettingsToggle
              checked={isEnabled}
              onChange={(value) => {
                setError(null);
                setSuccessMessage(null);
                if (value && !isEnabled) {
                  setPendingAction('enabling');
                } else if (!value && isEnabled) {
                  setPendingAction('confirmingDisable');
                }
              }}
              ariaLabel={t('security.enableAriaLabel')}
              disabled={isSaving}
            />
          </SettingsRow>

          {pendingAction === 'enabling' && (
            <div className="space-y-3 px-4 py-4">
              <Input
                type="password"
                placeholder={t('security.newPasswordPlaceholder')}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <Input
                type="password"
                placeholder={t('security.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <div className="flex gap-2">
                <Button onClick={() => void handleEnable()} disabled={isSaving}>
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('security.enableSubmit')}
                </Button>
                <Button
                  variant="outline"
                  disabled={isSaving}
                  onClick={() => {
                    resetFields();
                    setPendingAction('idle');
                  }}
                >
                  {t('security.cancel')}
                </Button>
              </div>
            </div>
          )}

          {pendingAction === 'confirmingDisable' && (
            <div className="space-y-3 px-4 py-4">
              <p className="text-sm text-destructive">{t('security.disableWarning')}</p>
              <div className="flex gap-2">
                <Button variant="destructive" onClick={() => void handleDisable()} disabled={isSaving}>
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('security.disableConfirm')}
                </Button>
                <Button variant="outline" disabled={isSaving} onClick={() => setPendingAction('idle')}>
                  {t('security.cancel')}
                </Button>
              </div>
            </div>
          )}

          {isEnabled && pendingAction === 'idle' && (
            <div className="space-y-3 px-4 py-4">
              <div className="text-sm font-medium text-foreground">{t('security.changePasswordTitle')}</div>
              <Input
                type="password"
                placeholder={t('security.currentPasswordPlaceholder')}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
              <Input
                type="password"
                placeholder={t('security.newPasswordPlaceholder')}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <Input
                type="password"
                placeholder={t('security.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <Button onClick={() => void handleChangePassword()} disabled={isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('security.changePasswordSubmit')}
              </Button>
              {successMessage && (
                <p className="text-sm text-green-600 dark:text-green-400">{successMessage}</p>
              )}
            </div>
          )}

          {error && (
            <div className="mx-4 mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
