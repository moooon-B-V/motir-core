'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  CreditCard,
  FolderGit2,
  Hourglass,
  Info,
  Layers,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { signOut } from '@/lib/auth/client';
import type { OrganizationDeletionConsequencesDTO } from '@/lib/dto/organizationDeletion';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { DELETE_ORGANIZATION_DIALOG } from './deleteOrganizationDialogParam';

// Delete organization — the Danger zone's live button and its two-step dialog
// (Story MOTIR-6306 · MOTIR-6402, design MOTIR-6390 panels 1–3).
//
//   step 1 — what will be deleted: the counts, the hosted repositories with Take
//            over, the subscription, the personal export and the date — every
//            number from `organizationDeletionService.getConsequences`, read on
//            the server, never a guess;
//   step 2 — confirm it's you: the org's exact name gates the button, then the
//            step-up — a password for an account with one; for one without, a
//            sign-in within the last ten minutes (DECISION §1), else a Sign in
//            again callout.
//
// The submit is MOTIR-6399's `POST /api/organizations/[orgId]/deletion`, which
// re-checks all three proofs on the server. A refusal keeps the dialog open with
// an inline error and schedules nothing.
//
// ⚠️ PAGE STATE AFTER THE MUTATION (motir-core/CLAUDE.md, case 2): the Danger zone
// and the app-wide closing bar are SERVER-rendered, so success is a
// `router.refresh()` — never a local patch. The deep-link `dialog` param is
// dropped first so the refresh cannot re-open the dialog.

/** Where the Take over act lives — each project's Repositories settings (MOTIR-711). */
const TAKEOVER_HREF = '/settings/project/repositories';
const EXPORT_HREF = '/settings/account/data';

type Step = 1 | 2;

export function DeleteOrganizationControl({
  orgId,
  orgName,
  consequences,
  initialOpen,
}: {
  orgId: string;
  orgName: string;
  consequences: OrganizationDeletionConsequencesDTO;
  initialOpen: boolean;
}) {
  const t = useTranslations('orgAdmin');
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <Button
        variant="danger"
        leftIcon={<Trash2 className="h-4 w-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        {t('settings.deleteOrgCta')}
      </Button>
      {open ? (
        <DeleteOrganizationDialog
          orgId={orgId}
          orgName={orgName}
          consequences={consequences}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function DeleteOrganizationDialog({
  orgId,
  orgName,
  consequences,
  onClose,
}: {
  orgId: string;
  orgName: string;
  consequences: OrganizationDeletionConsequencesDTO;
  onClose: () => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const date = formatDate(consequences.erasureDueAt, locale);
  const nameMatches = typed === orgName;
  const needsReauth = !consequences.hasPassword && !consequences.signedInRecently;
  const stepUpReady = consequences.hasPassword ? password.length > 0 : !needsReauth;
  const canSubmit = nameMatches && stepUpReady && !isPending;

  function submit(): void {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/organizations/${orgId}/deletion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            consequences.hasPassword ? { confirmName: typed, password } : { confirmName: typed },
          ),
        });
      } catch {
        setError(t('delete.errorGeneric'));
        return;
      }
      if (res.ok) {
        onClose();
        const url = new URL(window.location.href);
        if (url.searchParams.has('dialog')) {
          url.searchParams.delete('dialog');
          router.replace(`${url.pathname}${url.search}`);
        }
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        reason?: string;
      } | null;
      setError(refusalMessage(body));
    });
  }

  function refusalMessage(body: { code?: string; reason?: string } | null): string {
    switch (body?.code) {
      case 'STEP_UP_FAILED':
        return body.reason === 'reauth_required'
          ? t('delete.reauthTitle')
          : t('delete.errorPassword');
      case 'ORGANIZATION_DELETION_ALREADY_SCHEDULED':
        return t('delete.errorAlreadyScheduled', { org: orgName });
      case 'ORGANIZATION_CLOSING':
        return t('delete.errorAlreadyScheduled', { org: orgName });
      case 'ORGANIZATION_NAME_MISMATCH':
        return t('delete.nameMismatch');
      default:
        return t('delete.errorGeneric');
    }
  }

  async function signInAgain(): Promise<void> {
    await signOut();
    const next = `/settings/organization?dialog=${DELETE_ORGANIZATION_DIALOG}`;
    window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  const workspaceCount = consequences.workspaceNames.length;
  const hosted = consequences.hostedRepos;

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o && !isPending) onClose();
      }}
      size="md"
      srTitle={t('delete.title', { org: orgName })}
    >
      <div className="mb-(--spacing-sm) flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-rose)">
          <Trash2 className="h-5 w-5 text-(--el-danger-on-surface)" aria-hidden />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('delete.title', { org: orgName })}
          </h2>
          <p className="mt-1 font-sans text-sm text-(--el-text-secondary)">
            {step === 1 ? t('delete.step1Sub') : t('delete.step2Sub', { date })}
          </p>
        </div>
      </div>
      <p className="mb-(--spacing-sm) font-mono text-xs text-(--el-text-secondary)">
        {step === 1 ? t('delete.step1Label') : t('delete.step2Label')}
      </p>

      {step === 1 ? (
        <>
          <Modal.Body className="gap-(--spacing-md)">
            <ul
              className="divide-y divide-(--el-border-soft) rounded-(--radius-card) border border-(--el-border)"
              data-testid="org-deletion-consequences"
            >
              <ConsequenceRow icon={<Layers className="h-4 w-4" aria-hidden />}>
                {t.rich('delete.workspaces', {
                  workspaces: workspaceCount,
                  projects: consequences.projectCount,
                  b: (chunks) => <b className="text-(--el-text)">{chunks}</b>,
                })}
                {workspaceCount > 0 ? (
                  <span className="mt-0.5 block text-(--el-text-secondary)">
                    {consequences.workspaceNames.join(' · ')}
                  </span>
                ) : null}
              </ConsequenceRow>
              <ConsequenceRow icon={<Users className="h-4 w-4" aria-hidden />}>
                {t.rich('delete.members', {
                  count: consequences.memberCount,
                  date,
                  b: (chunks) => <b className="text-(--el-text)">{chunks}</b>,
                })}
                <a
                  href={EXPORT_HREF}
                  className="mt-0.5 block text-(--el-link) hover:text-(--el-link-pressed)"
                >
                  {t('delete.exportLink')}
                </a>
              </ConsequenceRow>
              {hosted.length > 0 ? (
                <ConsequenceRow icon={<FolderGit2 className="h-4 w-4" aria-hidden />}>
                  {t.rich('delete.hostedRepos', {
                    count: hosted.length,
                    b: (chunks) => <b className="text-(--el-text)">{chunks}</b>,
                  })}
                  {hosted.map((r) => (
                    <span key={r.id} className="mt-0.5 block font-mono text-(--el-text-secondary)">
                      {r.fullName} ·{' '}
                      <a
                        href={TAKEOVER_HREF}
                        className="font-sans text-(--el-link) hover:text-(--el-link-pressed)"
                      >
                        {t('delete.takeOver')}
                      </a>
                    </span>
                  ))}
                  <span className="mt-0.5 block text-(--el-text-secondary)">
                    {t('delete.connectedRepos')}
                  </span>
                </ConsequenceRow>
              ) : null}
              <ConsequenceRow icon={<CreditCard className="h-4 w-4" aria-hidden />}>
                {t.rich('delete.subscription', {
                  b: (chunks) => <b className="text-(--el-text)">{chunks}</b>,
                })}
                <span className="mt-0.5 block text-(--el-text-secondary)">
                  {t('delete.billingKept')}
                </span>
              </ConsequenceRow>
            </ul>
            <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-3 font-sans text-sm">
              <Hourglass
                className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
                aria-hidden
              />
              <span>
                <b className="text-(--el-text-strong)">{t('delete.dateTitle', { date })}</b>
                <span className="mt-0.5 block text-(--el-text-strong)">
                  {t('delete.dateSub', { org: orgName })}
                </span>
              </span>
            </div>
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button variant="ghost" onClick={onClose}>
              {tc('cancel')}
            </Button>
            <Button variant="danger" onClick={() => setStep(2)}>
              {t('delete.continue')}
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Modal.Body className="gap-(--spacing-md)">
            <Input
              label={t('delete.confirmLabel', { org: orgName })}
              placeholder={orgName}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              error={typed.length > 0 && !nameMatches ? t('delete.nameMismatch') : undefined}
            />
            {consequences.hasPassword ? (
              <Input
                type="password"
                label={t('delete.passwordLabel')}
                placeholder={t('delete.passwordLabel')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isPending}
                autoComplete="current-password"
                helperText={t('delete.passwordHint')}
              />
            ) : needsReauth ? (
              <div
                className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-3 font-sans text-sm text-(--el-text-strong)"
                data-testid="org-deletion-reauth"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <div>
                  <p className="font-semibold">{t('delete.reauthTitle')}</p>
                  <p className="mt-0.5">{t('delete.reauthBody')}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => void signInAgain()}
                  >
                    {t('delete.reauthCta')}
                  </Button>
                </div>
              </div>
            ) : null}
            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-3 font-sans text-sm text-(--el-text-strong)"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
                <span>{error}</span>
              </div>
            ) : null}
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                setStep(1);
              }}
              disabled={isPending}
            >
              {t('delete.back')}
            </Button>
            <Button type="submit" variant="danger" disabled={!canSubmit} loading={isPending}>
              {isPending ? t('delete.pending') : t('delete.confirm')}
            </Button>
          </Modal.Footer>
        </form>
      )}
    </Modal>
  );
}

function ConsequenceRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 font-sans text-sm text-(--el-text-secondary)">
      <span className="mt-0.5 shrink-0 text-(--el-text-secondary)">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
