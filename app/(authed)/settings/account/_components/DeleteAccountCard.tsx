import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Building2, TriangleAlert, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import type { ErasureBlockingOrganizationDTO } from '@/lib/dto/accountErasure';
import { ACCOUNT_ERASURE_WINDOW_DAYS } from '@/lib/users/dataSubjectRequests';
import { SettingsCallout } from './SettingsCallout';

// The "Delete your account" card on the Account › Data & privacy pane (Story 8.4
// · Subtask MOTIR-1136), built to `design/settings/account-data.mock.html`
// panels 1 and 4.
//
// ⚠️ THE BLOCK IS READ, NEVER CAUGHT. Design DECISION 5, and the specific
// failure this card names: the pane ASKS whether deletion is possible — from
// MOTIR-3699's impact preview, which evaluates `assertNotLastOwner`'s CONDITION
// as a read and takes no lock — and renders the refusal at rest. It does not
// call the delete path and translate `LastOrgOwnerError` into an error message.
// A blocked state discovered at submit is a design defect, and the reader would
// have typed their own email address into a form that was always going to
// refuse.
//
// A SERVER COMPONENT: everything it draws is a function of that preview, and it
// holds no state of its own.
//
// ⚠️ WHAT IT DOES NOT OWN — THE CONFIRMATION. The unblocked control opens the
// deleted / anonymised / kept ledger, and that modal (with the scheduled state
// and the app-wide cancel banner) is MOTIR-3704's surface, which this card
// blocks. So the control here is DRAWN and NOT WIRED, deliberately: the ledger
// is what makes an irreversible write safe to reach, and giving the write a door
// before the confirmation that gates it exists would be exactly backwards.

export interface DeleteAccountCardProps {
  /**
   * `true` exactly when the reader is the last owner of an organization other
   * people belong to — MOTIR-3699's `previewAccountErasure().blocked`.
   */
  blocked: boolean;
  /** The organization doing the blocking, when one is. */
  blockingOrganization: ErasureBlockingOrganizationDTO | null;
}

export async function DeleteAccountCard({ blocked, blockingOrganization }: DeleteAccountCardProps) {
  const t = await getTranslations('settings.account.data.delete');

  // `blocked` and the organization row are the same fact read twice, so trust
  // the row: a `blocked: true` carrying no organization has nothing to name, and
  // a disabled control with an empty explanation is worse than the ordinary one.
  const block = blocked ? blockingOrganization : null;

  return (
    <Card
      // The shipped danger-zone treatment, mirrored from
      // `settings/workspace/_components/DangerZoneCard.tsx`.
      //
      // ⚠️ THE HEADING DROPS TO `--el-text` IN DARK, and that is measured rather
      // than stylistic: `--el-danger` as normal-size TEXT is 4.51:1 on the light
      // page and 4.25:1 on the dark one, so it clears AA in one theme and misses
      // it in the other, and the base dark block does not flip
      // `--color-destructive`. The danger SIGNAL is carried by the 2 px border
      // and the trash glyph, which need only the 3:1 graphics bar and clear it at
      // 4.25 (the design's own sweep, reproduced in its notes).
      className="border-2 border-(--el-danger)"
      header={
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-sans text-base font-semibold text-(--el-danger) dark:text-(--el-text)">
              {t('title')}
            </h3>
            <p className="mt-0.5 max-w-[54ch] font-sans text-sm text-(--el-text-muted)">
              {block === null
                ? t('subtitle', { days: ACCOUNT_ERASURE_WINDOW_DAYS })
                : t('blocked.title')}
            </p>
          </div>
          {block === null ? null : (
            <Pill severity="warning" className="shrink-0">
              <TriangleAlert aria-hidden className="h-3 w-3" /> {t('blocked.pill')}
            </Pill>
          )}
        </div>
      }
    >
      <div className="border-t border-(--el-border-soft) pt-4">
        {block === null ? null : (
          <>
            <SettingsCallout
              tone="warn"
              icon={<TriangleAlert aria-hidden className="h-[18px] w-[18px]" />}
            >
              {t.rich('blocked.body', { b: (chunks) => <b>{chunks}</b> })}
            </SettingsCallout>

            {/* The way OUT, drawn on the pane: the organization named, its size
                shown, and a control that goes where the owner role is handed
                over. The reader is never left to work out where to look. */}
            <div className="mt-3 flex items-center gap-2.5 rounded-(--radius-input) border border-(--el-border) p-3">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
                <Building2 aria-hidden className="h-[15px] w-[15px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-sm font-medium text-(--el-text)">
                  {block.name}
                </span>
                <span className="mt-0.5 block font-sans text-xs text-(--el-text-secondary)">
                  {t('blocked.orgRow', { count: block.memberCount })}
                </span>
              </span>
              <Link
                href="/settings/organization/members"
                className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              >
                {t('blocked.manageMembers')}
              </Link>
            </div>
          </>
        )}

        <div className={`flex items-center justify-between gap-6 ${block === null ? '' : 'mt-4'}`}>
          <div className="min-w-0">
            <div className="font-sans text-sm font-medium text-(--el-text)">{t('rowTitle')}</div>
            <div className="mt-0.5 max-w-[46ch] font-sans text-xs leading-snug text-(--el-text-muted)">
              {block === null ? t('rowDesc') : t('blocked.disabledReason')}
            </div>
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={block !== null}
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            {t('cta')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
