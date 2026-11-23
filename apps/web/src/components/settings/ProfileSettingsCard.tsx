import { useTranslation } from 'react-i18next';
import type { CurrentUser } from '../../types';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { ReadOnlyField } from '@rexezuge/web';

export function ProfileSettingsCard({
  user,
}: {
  user: CurrentUser;
  setUser: (user: CurrentUser) => void;
  showNotice: (kind: 'success' | 'error', message: string) => void;
}) {
  const { t } = useTranslation();
  const initial = user.email.trim().charAt(0).toUpperCase() || '?';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-surface-3)] text-xs font-semibold text-[var(--color-text-secondary)]"
            >
              {initial}
            </span>
            {t('settings.profile', 'Profile')}
          </span>
        </CardTitle>
      </CardHeader>
      <div className="space-y-3">
        <ReadOnlyField label={t('settings.email', 'Email')} value={user.email} />
      </div>
    </Card>
  );
}
