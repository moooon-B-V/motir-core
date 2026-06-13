import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

// Org danger zone (design/org-admin panel 2). Deleting an org is a destructive
// cascade across every workspace and is NOT part of 6.10.4's service surface,
// so the action is rendered DISABLED with an explanatory note (the same honest
// treatment as the billing placeholder) rather than a fake control. The slot
// keeps the layout stable for when org deletion lands.
export async function DangerZoneCard() {
  const t = await getTranslations('orgAdmin');
  return (
    <Card
      header={
        <h2 className="font-sans text-base font-semibold text-(--el-danger-text)">
          {t('settings.dangerZone')}
        </h2>
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <p className="text-(--el-text-muted) flex-1 font-sans text-sm">
          {t('settings.deleteOrgNote')}
        </p>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button variant="danger" disabled>
            {t('settings.deleteOrg')}
          </Button>
          <span className="text-(--el-text-faint) font-sans text-xs">
            {t('settings.deleteUnavailable')}
          </span>
        </div>
      </div>
    </Card>
  );
}
