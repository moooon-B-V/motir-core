import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import type {
  OrganizationDeletionConsequencesDTO,
  OrganizationDeletionRequestDTO,
} from '@/lib/dto/organizationDeletion';
import { TransferOwnershipControl } from './TransferOwnershipControl';
import { DeleteOrganizationControl } from './DeleteOrganizationDialog';
import { OrganizationDeletionScheduledCard } from './OrganizationDeletionScheduledCard';

// Org danger zone — the Owner's card (Story MOTIR-6167 · MOTIR-6313, design
// MOTIR-6303 panel 2; the Delete row made live by Story MOTIR-6306 · MOTIR-6402,
// design MOTIR-6390 panels 1 and 4). The page renders it ONLY for a viewer holding
// `transferOwnership` (`lib/organizations/capabilities.ts`): an Admin gets no card
// at all — hidden, not disabled (MOTIR-2462), panel 3.
//
// Two rows in the shipped workspace danger grammar (`border-2 --el-danger`, a 1 px
// rule between rows):
//   1. Transfer ownership — live; opens the transfer dialog (panel 4). While a
//      deletion is scheduled it renders DISABLED with its reason (MOTIR-6390
//      panel 4): the service refuses a transfer while closing anyway.
//   2. Delete organization — live (MOTIR-6390 panel 1): opens the two-step dialog.
//      While scheduled, the row is the Owner's scheduled card instead (panel 4).
export async function DangerZoneCard({
  orgId,
  orgName,
  openTransfer,
  openDelete,
  deletion,
  scheduledByName,
  consequences,
}: {
  orgId: string;
  orgName: string;
  /** The deep link (`?dialog=transfer-ownership`) — opens the dialog on arrival. */
  openTransfer: boolean;
  /** The deep link (`?dialog=delete-organization`) — the Sign in again round trip. */
  openDelete: boolean;
  /** The open deletion request, or null at rest. */
  deletion: OrganizationDeletionRequestDTO | null;
  scheduledByName: string | null;
  /** The dialog's step 1, read on the server — null while scheduled. */
  consequences: OrganizationDeletionConsequencesDTO | null;
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
        <TransferOwnershipControl
          orgId={orgId}
          orgName={orgName}
          initialOpen={openTransfer}
          disabledReason={deletion ? t('scheduled.transferBlocked') : null}
        />
      </div>

      <div className="my-4 h-px bg-(--el-border)" />

      {deletion ? (
        <OrganizationDeletionScheduledCard
          orgId={orgId}
          orgName={orgName}
          request={deletion}
          scheduledByName={scheduledByName}
        />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div>
            <p className="font-sans text-sm font-medium text-(--el-text)">
              {t('settings.deleteOrg')}
            </p>
            <p className="text-(--el-text-muted) font-sans text-xs">
              {t('settings.deleteOrgNoteLive', { org: orgName })}
            </p>
          </div>
          {consequences ? (
            <DeleteOrganizationControl
              orgId={orgId}
              orgName={orgName}
              consequences={consequences}
              initialOpen={openDelete}
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}
