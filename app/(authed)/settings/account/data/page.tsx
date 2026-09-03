import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Mail } from 'lucide-react';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { getSession } from '@/lib/auth';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { accountErasureService } from '@/lib/services/accountErasureService';
import { dataExportService } from '@/lib/services/dataExportService';
import { DATA_PRIVACY_MAILBOX, erasureDueAt } from '@/lib/users/dataSubjectRequests';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { AccountDeletionScheduledCard } from '../_components/AccountDeletionScheduledCard';
import { DataExportCard } from '../_components/DataExportCard';
import { DeleteAccountCard } from '../_components/DeleteAccountCard';
import { SettingsCallout } from '../_components/SettingsCallout';

// The `Data › Data & privacy` pane (Story 8.4 · Subtask MOTIR-1136) — the
// account-settings surface `motir.co/legal/privacy` §7 points at, in the
// product's own approved words: *"In your account settings you can export your
// personal data and request deletion of your account, without asking anyone."*
// Until this route existed that sentence was a promise the product did not keep.
//
// Design of record: `design/settings/account-data.mock.html` +
// `design/settings/design-notes.md` → `Data & privacy`. MOTIR-1136 built panels
// 1 (at rest), 2 (the export's states), 4 (BLOCKED) and 6 (dark parity);
// MOTIR-3704 added panel 3 (the confirmation ledger, behind the delete control)
// and panel 5 (the SCHEDULED state below, plus the app-wide cancel banner,
// which is mounted in the authed shell rather than here — a reader who changes
// their mind on day nine opens the app, not this pane).
//
// ONE pane for BOTH rights, not two rail entries — the design's argument, worth
// keeping: they are the same right exercised two ways, the Privacy Policy already
// names a single place, and a reader who came to leave should meet the export on
// the way out.
//
// A SERVER COMPONENT, in the settings family's arrival anatomy (MOTIR-3558):
// the page owns the centred column, the REAL header is painted above the
// boundary from the gate — a settings pane knows its own title before its first
// read returns, so a grey bar over it would cover a region that has something to
// show — and the shared `SettingsPaneFrame` is the fallback INSIDE it, so its
// width is inherited rather than re-declared.
//
// ⚠️ An in-page `<Suspense>`, never a `loading.tsx` — CLAUDE.md's boundary rule:
// a fallback above a route flushes the response head and fixes the status at 200.
export default async function AccountDataPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.account.data');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('title')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <DataPane userId={session.user.id} email={session.user.email} />
      </Suspense>

      {/* The pane is not the only route, and saying so is part of the promise:
          Art. 16/18/21 (correction, restriction, objection) have no control here
          and the Privacy Policy publishes a mailbox that a person answers. */}
      <SettingsCallout icon={<Mail aria-hidden className="h-[18px] w-[18px]" />}>
        {t.rich('mailbox', {
          mailbox: DATA_PRIVACY_MAILBOX,
          b: (chunks) => <b>{chunks}</b>,
        })}
      </SettingsCallout>
    </div>
  );
}

/**
 * The two cards, over the two reads this pane needs.
 *
 * TWO DISTINCT BACKEND CAPABILITIES, which is the design's point rather than an
 * implementation detail: the impact PREVIEW (MOTIR-3699 — what erasure would
 * reach, and whether it is possible at all) and the export REQUEST ROW
 * (MOTIR-3701). Neither is decoration and neither is free, and the preview in
 * particular is what lets the deletion card draw its refusal at rest instead of
 * raising one at submit.
 *
 * Read in parallel: they share no data and neither gates the other.
 */
async function DataPane({ userId, email }: { userId: string; email: string }) {
  const [preview, exportRequest, deletion] = await Promise.all([
    accountErasureService.previewAccountErasure(userId),
    dataExportService.getLatestExportForUser(userId),
    // The THIRD read, added by MOTIR-3704: is a deletion already scheduled?
    // It joins the wave rather than gating it — the pane renders one of two
    // deletion cards from it and neither read depends on the other.
    accountDeletionService.findOpenDeletion(userId),
  ]);

  const [t, locale] = await Promise.all([
    getTranslations('settings.account.data'),
    getLocale() as Promise<Locale>,
  ]);
  const soleMemberCount = preview.deleted.soleMemberWorkspaces.length;

  return (
    <div className="flex flex-col gap-6">
      {/* ⚠️ THE SCHEDULED STATE COMES FIRST AND THE EXPORT FOLLOWS IT, which is
          panel 5's own order and an argument rather than a layout: a reader
          looking at a dated erasure is being told, in the position they are
          already reading, that the export is still available and worth doing
          now. The design's words for the pane as a whole — *"a reader who came
          to leave should meet the export on the way out"* — are literal here. */}
      {deletion ? <AccountDeletionScheduledCard request={deletion} locale={locale} /> : null}

      <DataExportCard
        request={exportRequest}
        email={email}
        idleSubtitle={
          deletion
            ? t('delete.grace.exportSubtitle', {
                date: formatDate(deletion.erasureDueAt, locale),
              })
            : undefined
        }
      />

      {/* One or the other, never both: with a deletion pending there is nothing
          left to ask for, and the only act available is taking it back. */}
      {deletion ? null : (
        <DeleteAccountCard
          preview={preview}
          email={email}
          // Computed on the SERVER so the dialog's "erased on <date>" is stable
          // across the hydration boundary, and derived from the ONE published
          // constant through its named helper — the literal `30` appears in no
          // component and in no copy.
          projectedErasureDueAt={erasureDueAt(new Date()).toISOString()}
        />
      )}
      {/* Drawn beside the BLOCKED card only (panel 4), because that is the
          confusion it exists to clear: with an organization block on screen, a
          reader has every reason to assume their sole-membership workspaces are
          a second one. They are not — `deleteWorkspace` asserts membership and
          checks no role — so they are a CHOICE the ledger presents, and the
          escape is stated here rather than discovered at submit. */}
      {!deletion && preview.blocked && soleMemberCount > 0 ? (
        <SettingsCallout>
          {t.rich('delete.blocked.workspaces', {
            count: soleMemberCount,
            b: (chunks) => <b>{chunks}</b>,
          })}
        </SettingsCallout>
      ) : null}
    </div>
  );
}
