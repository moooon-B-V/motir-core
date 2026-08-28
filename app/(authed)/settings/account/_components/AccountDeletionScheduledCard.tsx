import { getTranslations } from 'next-intl/server';
import { Hourglass } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { AccountDeletionRequestDTO } from '@/lib/dto/accountErasure';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { daysUntil } from '@/lib/users/dataSubjectRequests';
import { CancelAccountDeletionButton } from './CancelAccountDeletionButton';

// The SCHEDULED state on the `Data › Data & privacy` pane —
// `design/settings/account-data.mock.html` PANEL 5, the FIRST of design
// DECISION 4's two cancel doors (Story 8.4 · Subtask MOTIR-3704).
//
// It replaces the delete card rather than sitting beside it: there is nothing
// left to ask for, and the only act available is taking it back.
//
// A SERVER COMPONENT, and that is the page-state decision rather than a habit.
// `router.refresh()` re-runs a server read and reaches exactly this
// (CLAUDE.md's contract, route 2), so a cancel from the OTHER door — the
// app-wide banner — repaints this card without a reload. The one piece of
// client state is the button.
//
// ⚠️ THE DATE AND THE COUNTDOWN COME FROM THE ROW. `erasureDueAt` is persisted
// at create precisely so a later change to `ACCOUNT_ERASURE_WINDOW_DAYS` cannot
// move a deadline somebody has already been shown, and so a reader who
// scheduled on Monday is told Monday's deadline on Thursday. Nothing here
// recomputes `now + 30 days`, and the literal `30` appears nowhere.

export interface AccountDeletionScheduledCardProps {
  request: AccountDeletionRequestDTO;
  locale: Locale;
  /** Injectable clock, so the countdown is assertable rather than wall-clock. */
  now?: Date;
}

export async function AccountDeletionScheduledCard({
  request,
  locale,
  now = new Date(),
}: AccountDeletionScheduledCardProps) {
  const t = await getTranslations('settings.account.data.delete.grace');
  const dueDate = formatDate(request.erasureDueAt, locale);
  const daysLeft = t('daysLeft', { days: daysUntil(request.erasureDueAt, now) });

  return (
    <Card className="border-2 border-(--el-danger)">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-rose) text-(--el-danger)">
          <Hourglass aria-hidden className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-base font-semibold text-(--el-danger) dark:text-(--el-text)">
            {t('title', { date: dueDate })}
          </h3>
          <p className="mt-1 max-w-[54ch] font-sans text-sm text-(--el-text-muted)">
            {t.rich('body', { daysLeft, b: (chunks) => <b>{chunks}</b> })}
          </p>
        </div>
        <CancelAccountDeletionButton label={t('cancel')} />
      </div>
    </Card>
  );
}
