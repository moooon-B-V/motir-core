import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TransferOwnershipControl } from './TransferOwnershipControl';

// Org danger zone — the Owner's card (Story MOTIR-6167 · MOTIR-6313, design
// MOTIR-6303 panel 2). The page renders it ONLY for a viewer holding
// `transferOwnership` (`lib/organizations/capabilities.ts`): an Admin gets no card
// at all — hidden, not disabled (MOTIR-2462), panel 3.
//
// Two rows in the shipped workspace danger grammar (`border-2 --el-danger`, a 1 px
// rule between rows):
//   1. Transfer ownership — live; opens the transfer dialog (panel 4).
//   2. Delete organization — KEEPS the disabled treatment and its "isn't available
//      yet" note. Deleting an org is MOTIR-6306's story, which redraws this row.
export async function DangerZoneCard({
  orgId,
  orgName,
  openTransfer,
}: {
  orgId: string;
  orgName: string;
  /** The deep link (`?dialog=transfer-ownership`) — opens the dialog on arrival. */
  openTransfer: boolean;
}) {
  const t = await getTranslations('orgAdmin');
  return (
    <Card
      className="border-2 border-(--el-danger)"
      header={
        <h2 className="font-sans text-base font-semibold text-(--el-danger-on-surface)">
          {t('settings.dangerZone')}
        </h2>
      }
    >
      {/* `#transfer-ownership` is the roster Owner row's link target (MOTIR-6311);
          the control opens its dialog on that hash, like the `dialog` param. */}
      <div
        id="transfer-ownership"
        className="flex scroll-mt-4 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      >
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('settings.transferTitle')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">{t('settings.transferDesc')}</p>
        </div>
        <TransferOwnershipControl orgId={orgId} orgName={orgName} initialOpen={openTransfer} />
      </div>

      <div className="my-4 h-px bg-(--el-border)" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('settings.deleteOrg')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">{t('settings.deleteOrgNote')}</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Button variant="danger" disabled>
            {t('settings.deleteOrg')}
          </Button>
          <span className="text-(--el-text-secondary) font-sans text-xs">
            {t('settings.deleteUnavailable')}
          </span>
        </div>
      </div>
    </Card>
  );
}
