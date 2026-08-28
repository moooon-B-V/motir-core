'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Clock,
  Database,
  FileArchive,
  MessageSquare,
  Receipt,
  SquareKanban,
  Trash2,
  TriangleAlert,
  User,
  UserX,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type {
  AccountErasureKeptException,
  AccountErasurePreviewDTO,
} from '@/lib/dto/accountErasure';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { scheduleAccountDeletionAction } from '@/app/(authed)/_account-deletion-actions';
import { SettingsCallout } from './SettingsCallout';

// The deletion confirmation — `design/settings/account-data.mock.html` PANEL 3
// (Story 8.4 · Subtask MOTIR-3704).
//
// ── IT IS A LEDGER BEFORE IT IS A CONFIRM BOX ───────────────────────────────
// Design DECISION 3, and the reason this surface is its own card: three groups,
// each with the reason it belongs there, and each group's membership follows
// from a SOURCE rather than from taste. `deleted` is what the reader owns alone;
// `anonymised` is what the Privacy Policy §6 has already decided about somebody
// else's conversation; `kept` is the part a confirmation must never promise
// away, because Art. 17 erasure is not absolute and a dialog that implies
// otherwise is a false statement on a consent surface.
//
// ⚠️ DRAWN AT ITS REAL CEILING, AND THE CUT IS THE POINT. `contentVariants`
// caps a modal at `max-h-[90vh]` and `Modal.Body` is
// `flex min-h-0 flex-1 overflow-y-auto`, so the head and the footer are pinned
// by the flex column and the body scrolls. On the 1366×768 laptop floor that is
// **691 px**, and the ledger does not fit. That is a PROPERTY TO KEEP, not a
// layout bug: the type-to-confirm field sits at the BOTTOM of the scroll, so the
// confirm button cannot be reached without travelling past what is about to be
// deleted, anonymised and kept. **Nothing here raises the cap** — no
// `max-h-*` on `className`, no bespoke sticky rule — and raising it would draw a
// dialog the shipped `Modal` cannot render. `tests/settings/accountDeletionConfirm.test.tsx`
// asserts the absence rather than trusting this paragraph.
//
// `size="lg"` (32 rem) rather than the shipped workspace delete's `md`: the
// ledger needs the width, and the next size up is the 58 rem peek surface, which
// is not a confirmation dialog.
//
// ⚠️ THE DATE IS A PROP, NOT A CLIENT CLOCK. `erasureDueAt` is computed on the
// SERVER from `erasureDueAt(new Date())` — the named helper over the ONE
// published constant, never a retyped `30` — and handed down. A client
// component calling `Date.now()` during render would disagree with its own
// server pass and hydrate mismatched; and once the deletion is scheduled, every
// later reader is shown the ROW's `erasureDueAt` instead, because somebody who
// scheduled on Monday must be told Monday's deadline.

export interface DeleteAccountConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** MOTIR-3699's impact preview — what the three groups render. */
  preview: AccountErasurePreviewDTO;
  /** The reader's own address: the ledger's subject, and the type-to-confirm value. */
  email: string;
  /**
   * When the erasure WOULD fall due if the reader confirmed now — an ISO string
   * computed server-side from `erasureDueAt()`. See the clock note above.
   */
  projectedErasureDueAt: string;
}

export function DeleteAccountConfirmModal({
  open,
  onOpenChange,
  preview,
  email,
  projectedErasureDueAt,
}: DeleteAccountConfirmModalProps) {
  const t = useTranslations('settings.account.data.delete');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { toast } = useToast();

  const [typed, setTyped] = useState('');
  const [isPending, startTransition] = useTransition();

  // Case-sensitive exact match, the same bar the shipped workspace delete sets.
  const matches = typed === email;

  function close(next: boolean): void {
    if (!next) setTyped('');
    onOpenChange(next);
  }

  function confirm(): void {
    if (!matches) return;
    startTransition(async () => {
      const result = await scheduleAccountDeletionAction();
      if (result.ok) {
        close(false);
        // The pane is SERVER-rendered and so is the app-wide banner's shell
        // slot, so one refresh repaints both (CLAUDE.md's page-state contract,
        // route 2). The action already revalidated the pane's path; this is what
        // reaches the layout above whatever route the reader is standing on.
        router.refresh();
        return;
      }
      toast({
        variant: 'error',
        title: result.code === 'BLOCKED' ? t('confirm.blockedError') : t('confirm.error'),
      });
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      // A destructive confirm: assistive tech should treat it as an alert that
      // interrupts and announces its description, the same call 2.8.4 made.
      role="alertdialog"
      size="lg"
      // The dialog renders its OWN visible heading beside the danger glyph, so
      // Radix is given the accessible name explicitly rather than falling back
      // to the generic "Dialog".
      srTitle={t('confirm.title')}
    >
      <div className="mb-(--spacing-md) flex shrink-0 items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-rose) text-(--el-danger)">
          <TriangleAlert aria-hidden className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('confirm.title')}
          </h2>
          <p className="mt-1 font-sans text-sm text-(--el-text-muted)">
            {t('confirm.body', { email })}
          </p>
        </div>
      </div>

      {/*
        ⚠️ NO HEIGHT CLASS HERE. `Modal.Body` already owns the scroll recipe
        (`flex min-h-0 flex-1 overflow-y-auto`) against the panel's `max-h-[90vh]`
        cap, and the whole design of this dialog rests on that cap holding.
      */}
      <Modal.Body className="flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          <LedgerGroup
            tone="text-(--el-danger)"
            icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
            heading={t('ledger.deleted')}
            why={t('ledger.deletedWhy')}
          >
            <LedgerRow
              icon={<User aria-hidden className="h-4 w-4" />}
              name={t('ledger.identity.name')}
              desc={t('ledger.identity.desc')}
            />
            {/* NAMED, never only counted — the design's own requirement, and the
                reason `soleMemberWorkspaces` carries names in the DTO at all. A
                sole-membership workspace has exactly two futures, and the escape
                is stated here rather than discovered at submit. */}
            {preview.deleted.soleMemberWorkspaces.length > 0 ? (
              <>
                <LedgerRow
                  icon={<Users aria-hidden className="h-4 w-4" />}
                  name={t('ledger.soleWorkspaces.name')}
                  desc={t('ledger.soleWorkspaces.desc', {
                    names: preview.deleted.soleMemberWorkspaces.map((w) => w.name).join(' · '),
                    count: preview.deleted.soleMemberWorkspaces.length,
                  })}
                  count={preview.deleted.soleMemberWorkspaces.length}
                />
                <LedgerRow
                  icon={<SquareKanban aria-hidden className="h-4 w-4" />}
                  name={t('ledger.soleWorkspacesWork.name')}
                  desc={t('ledger.soleWorkspacesWork.desc', {
                    projects: preview.deleted.projects,
                  })}
                  count={preview.deleted.workItems}
                />
              </>
            ) : null}
            {/* THE ARCHIVE, and it is the reason this row exists rather than a
                sentence somewhere (Bug MOTIR-3747). MOTIR-3732 made erasure
                delete every export request and the file each one built, and the
                pane above deliberately routes the reader PAST the export on the
                way to this dialog — so a ledger that names credentials and
                workspaces and stays silent about the one artefact that is a
                complete copy of everything they held is the omission this
                surface cannot afford. HIDDEN at zero, the same rule the
                workspace rows follow: the ledger states what deletion reaches,
                and a reader who never asked for an archive loses none. The copy
                names the ARCHIVE, not the request row — and it describes what
                goes rather than promising a download exists, because a
                `preparing` / `failed` / `expired` row carries no file. */}
            {preview.deleted.dataExports > 0 ? (
              <LedgerRow
                icon={<FileArchive aria-hidden className="h-4 w-4" />}
                name={t('ledger.dataExports.name')}
                desc={t('ledger.dataExports.desc', { count: preview.deleted.dataExports })}
                count={preview.deleted.dataExports}
              />
            ) : null}
          </LedgerGroup>

          <LedgerGroup
            tone="text-(--el-info)"
            icon={<UserX aria-hidden className="h-3.5 w-3.5" />}
            heading={t('ledger.anonymised')}
            why={t('ledger.anonymisedWhy')}
          >
            <LedgerRow
              icon={<MessageSquare aria-hidden className="h-4 w-4" />}
              name={t('ledger.comments.name')}
              desc={t('ledger.comments.desc')}
              count={preview.anonymised.comments}
            />
            <LedgerRow
              icon={<SquareKanban aria-hidden className="h-4 w-4" />}
              name={t('ledger.workItems.name')}
              desc={t('ledger.workItems.desc')}
              count={preview.anonymised.workItems}
            />
          </LedgerGroup>

          {/* NOT counted from the database — `content/legal/privacy.md` §6
              states these as exceptions, so the preview returns KEYS and the
              copy renders them. That is what keeps the pane's list and the
              Privacy Policy's list from drifting into two different lists. */}
          <LedgerGroup
            tone="text-(--el-warning)"
            icon={<Receipt aria-hidden className="h-3.5 w-3.5" />}
            heading={t('ledger.kept')}
            why={t('ledger.keptWhy')}
          >
            {preview.kept.map((exception) => (
              <LedgerRow
                key={exception}
                icon={KEPT_ICONS[exception]}
                name={t(`ledger.${exception}.name`)}
                desc={t(`ledger.${exception}.desc`)}
              />
            ))}
          </LedgerGroup>
        </div>

        <SettingsCallout tone="warn" icon={<Clock aria-hidden className="h-[18px] w-[18px]" />}>
          {t.rich('confirm.schedule', {
            date: formatDate(projectedErasureDueAt, locale),
            b: (chunks) => <b>{chunks}</b>,
          })}
        </SettingsCallout>

        {/*
          ⚠️ LAST IN DOM ORDER, AND THAT IS THE DISCIPLINE RATHER THAN A LAYOUT
          CHOICE. Below the ledger and below the schedule note, so the field —
          and therefore the enabled confirm — is only reachable by scrolling past
          every fact above it. Moving it up would defeat the cut the modal is
          drawn around.
        */}
        <form
          id="delete-account-confirm"
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <Input
            label={t('confirm.typeLabel', { email })}
            placeholder={email}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            helperText={t('confirm.helper')}
            autoComplete="off"
            autoFocus
          />
        </form>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={() => close(false)} disabled={isPending}>
          {t('confirm.cancel')}
        </Button>
        <Button
          type="submit"
          form="delete-account-confirm"
          variant="danger"
          disabled={!matches}
          loading={isPending}
        >
          {t('confirm.button')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** The `kept` group's glyphs, keyed by the closed exception set. */
const KEPT_ICONS: Record<AccountErasureKeptException, ReactNode> = {
  billing_records: <Receipt aria-hidden className="h-4 w-4" />,
  backups: <Database aria-hidden className="h-4 w-4" />,
};

/**
 * One ledger group — its glyph, its heading, and the REASON it exists.
 *
 * ⚠️ THE `why` IS NOT DECORATION. Each group's heading is a verdict and the
 * `why` is the source it follows from ("Yours alone" · "Part of someone else's
 * project" · "Required by law"), which is what turns a list of counts into an
 * explanation somebody can consent to.
 *
 * State is never colour alone (the asset's own a11y sweep): the tone tints a
 * GLYPH that is present in every theme, and the heading text is the label.
 */
function LedgerGroup({
  tone,
  icon,
  heading,
  why,
  children,
}: {
  tone: string;
  icon: ReactNode;
  heading: string;
  why: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-(--radius-card) border border-(--el-border-soft)">
      <h3 className="flex items-center gap-2 border-b border-(--el-border-soft) px-3.5 py-2.5 font-sans text-xs font-semibold tracking-wide text-(--el-text) uppercase">
        <span className={`inline-flex shrink-0 ${tone}`}>{icon}</span>
        {heading}
        <span className="ml-auto font-sans text-[11px] font-normal normal-case tracking-normal text-(--el-text-muted)">
          {why}
        </span>
      </h3>
      <div className="flex flex-col divide-y divide-(--el-border-soft)">{children}</div>
    </section>
  );
}

/** One row of a group: what it is, why, and — where there is one — how many. */
function LedgerRow({
  icon,
  name,
  desc,
  count,
}: {
  icon: ReactNode;
  name: string;
  desc: string;
  count?: number;
}) {
  return (
    <div className="flex items-start gap-2.5 px-3.5 py-3">
      <span className="mt-px inline-flex h-4 w-4 shrink-0 text-(--el-icon-muted)">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-sm font-medium text-(--el-text)">{name}</span>
        <span className="mt-0.5 block font-sans text-xs leading-snug text-(--el-text-muted)">
          {desc}
        </span>
      </span>
      {count === undefined ? null : (
        <span className="shrink-0 font-sans text-sm tabular-nums text-(--el-text-secondary)">
          {count.toLocaleString()}
        </span>
      )}
    </div>
  );
}
