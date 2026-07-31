'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Building2,
  Check,
  Clock,
  FolderGit2,
  Info,
  Lock,
  MoveUpRight,
  User,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { GithubMark } from '@/components/icons/GithubMark';
import { Modal } from '@/components/ui/Modal';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

// The TAKE-IT-OVER DECISION (Story MOTIR-1775 · MOTIR-1939 —
// design/repository-set §14, panels 2–3).
//
// ⚠️ THE DECISION IS A MODAL AND THE STATE IS NOT. Everything here is transient —
// pick a target, read what it costs, confirm — so it lives in a dialog.
// Everything AFTER it (`transfer_pending`, `awaiting_reinstall`) outlives the
// dialog, survives a reload and must be re-promptable, so it lives on the ROW.
// That split is precisely what stops a multi-day wait from being drawn as a
// spinner in a dialog nobody kept open.
//
// ⚠️ NEVER "ONE CLICK" (`docs/decisions/ci-minutes-allowance.md` §D, binding).
// The three real costs — an account you own, an ASYNCHRONOUS transfer you accept
// on GitHub, a re-install of the App on the new owner — are the confirm step's
// SUBSTANCE, not fine print under it. `costTransfer` says "It isn't instant" in
// the affirmative, because the honesty requirement is the point of the panel
// rather than a caveat beneath it.
//
// ⚠️ THE ORG LIST IS A LIVE CALL WITH REAL STATES. Nothing stores it, so it
// loads, and it can fail — both are rendered. The PERSONAL account is never
// behind that call, which is what lets a failed lookup DEGRADE to a working
// picker rather than trapping the user in an empty listbox.

interface GithubOrgOption {
  login: string;
  avatarUrl: string | null;
}

type OrgsState =
  | { status: 'loading' }
  | { status: 'loaded'; orgs: GithubOrgOption[] }
  | { status: 'failed' };

export interface TakeoverModalProps {
  row: ProjectRepoDto;
  /** The actor's connected GitHub login (grant 1), or null — the ONE fact that
   *  decides between the picker and MOTIR-1900's connect prompt. */
  githubLogin: string | null;
  /** Where the connect prompt hands off — the shipped 7.10 pane. */
  connectHref: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (row: ProjectRepoDto, newOwner: string) => void;
}

export function TakeoverModal({
  row,
  githubLogin,
  connectHref,
  busy,
  onClose,
  onConfirm,
}: TakeoverModalProps) {
  const t = useTranslations('repositoryTakeover');
  const ts = useTranslations('repositorySet');

  const repo = row.realizedRepo?.name ?? row.name;
  const [step, setStep] = useState<'target' | 'costs'>('target');
  const [target, setTarget] = useState<string>(githubLogin ?? '');
  const [orgs, setOrgs] = useState<OrgsState>({ status: 'loading' });

  // The org lookup. Sequence-guarded so a retry that resolves after a slower
  // first attempt cannot be overwritten by it (the stale-response rule the repo
  // applies to every optimistic reconcile).
  const seq = useRef(0);
  const loadOrgs = useCallback(async () => {
    if (!githubLogin) return;
    const mine = ++seq.current;
    setOrgs({ status: 'loading' });
    try {
      const res = await fetch('/api/github/organizations', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { organizations?: GithubOrgOption[] };
      if (mine !== seq.current) return;
      setOrgs({ status: 'loaded', orgs: body.organizations ?? [] });
    } catch {
      if (mine !== seq.current) return;
      // NOT an error state for the flow — the picker still works, with the
      // personal account. The banner says so in as many words.
      setOrgs({ status: 'failed' });
    }
  }, [githubLogin]);

  // ⚠️ THE FETCH RUNS INSIDE AN ASYNC IIFE, not as a bare call in the effect
  // body. A `setState` reached synchronously from an effect is a cascading render
  // and a CI lint failure in this repo; the async closure is the shape every
  // other effect-driven read here uses (`TierDocModal`), and it is what keeps the
  // loading announcement inside the asynchronous work rather than beside it.
  useEffect(() => {
    void (async () => {
      await loadOrgs();
    })();
  }, [loadOrgs]);

  // ── No identity → MOTIR-1900's connect prompt, REUSED. This flow adds no
  //    second connect prompt; the copy and both actions are that card's. ──────
  if (!githubLogin) {
    return (
      <Shell
        onClose={onClose}
        eyebrow={t('modalEyebrow')}
        title={t('connectTitle')}
        footer={
          <>
            <a
              href={connectHref}
              className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text)"
            >
              <GithubMark className="size-4 shrink-0" aria-hidden />
              {ts('connectGithub')}
            </a>
            <Button variant="ghost" onClick={onClose}>
              {ts('accessLater')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-(--el-text-secondary)">{ts('accessLead')}</p>
        <Notice tone="soft" icon={<Lock className="size-5 shrink-0 text-(--el-icon-muted)" />}>
          {t('connectWhy')}
        </Notice>
      </Shell>
    );
  }

  // ── Step 2 · what it costs, before anything is committed ──────────────────
  if (step === 'costs') {
    return (
      <Shell
        onClose={onClose}
        eyebrow={t('modalEyebrowStep2')}
        title={t('modalTitleTarget', { repo, login: target })}
        footer={
          <>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => onConfirm(row, target)}
              leftIcon={<MoveUpRight className="size-4 shrink-0" />}
            >
              {t('confirmCta')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStep('target')}>
              {t('back')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <SectionLabel>{t('costsHeading')}</SectionLabel>
          <ul className="flex flex-col gap-3">
            <Cost icon={<User className={COST_ICON} />} title={t('costAccount')}>
              {t('costAccountDetail', { login: target })}
            </Cost>
            <Cost icon={<Clock className={COST_ICON} />} title={t('costTransfer')}>
              {t('costTransferDetail', { login: target })}
            </Cost>
            <Cost icon={<FolderGit2 className={COST_ICON} />} title={t('costReinstall')}>
              {t('costReinstallDetail')}
            </Cost>
          </ul>
        </div>

        {/* Informational, not a warning: it states a FACT about who pays, and it
            carries §G's reassurance that Actions come back on — otherwise an
            honest cost list reads as pure loss and the ADR's real second answer
            looks like a punishment. */}
        <Notice tone="info" icon={<Zap className="size-5 shrink-0 text-(--el-info)" />}>
          <span className="font-semibold text-(--el-text-strong)">{t('billingConsequence')}</span>{' '}
          {t('billingConsequenceDetail')}
        </Notice>
      </Shell>
    );
  }

  // ── Step 1 · where should it go ───────────────────────────────────────────
  return (
    <Shell
      onClose={onClose}
      eyebrow={t('modalEyebrow')}
      title={t('modalTitle', { repo })}
      footer={
        <>
          <Button variant="primary" disabled={!target} onClick={() => setStep('costs')}>
            {ts('continueCta')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-(--el-text-secondary)">{t('modalLead')}</p>

      <TargetPicker
        personal={githubLogin}
        orgs={orgs}
        value={target}
        onChange={setTarget}
        onRetry={() => void loadOrgs()}
      />
    </Shell>
  );
}

const COST_ICON = 'size-5 shrink-0 text-(--el-icon-muted)';

/**
 * The target listbox — personal account first, then organizations.
 *
 * ⚠️ THE STATUS ROWS SIT OUTSIDE `role="listbox"`, ON PURPOSE. A listbox's
 * children must all be `option`s (`aria-required-children`, which axe flags as
 * critical — the same rule that governs this repo's Combobox and forbids action
 * buttons inside a `role="option"`). The spinner and the failure banner therefore
 * render INSIDE the bordered container but AFTER the listbox element, which keeps
 * the design's pixels and the a11y contract at once.
 *
 * ⚠️ THE PERSONAL OPTION IS PRESENT FROM FIRST PAINT and never behind the
 * network, so a slow or failed lookup can never trap keyboard focus in an empty
 * listbox — the degradation the design is built around.
 */
function TargetPicker({
  personal,
  orgs,
  value,
  onChange,
  onRetry,
}: {
  personal: string;
  orgs: OrgsState;
  value: string;
  onChange: (login: string) => void;
  onRetry: () => void;
}) {
  const t = useTranslations('repositoryTakeover');
  const labelId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-(--el-text)">
        {t('targetLabel')}
      </span>

      <div className="flex flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-card)">
        <div role="listbox" aria-labelledby={labelId} className="flex flex-col p-1.5">
          <Group label={t('targetGroupPersonal')}>
            <Option
              selected={value === personal}
              onSelect={() => onChange(personal)}
              icon={<User className="size-4 shrink-0 text-(--el-icon-muted)" />}
              caption={t('targetPersonalCaption')}
            >
              {personal}
            </Option>
          </Group>

          {orgs.status === 'loaded' && orgs.orgs.length > 0 ? (
            <Group label={t('targetGroupOrgs')}>
              {orgs.orgs.map((org) => (
                <Option
                  key={org.login}
                  selected={value === org.login}
                  onSelect={() => onChange(org.login)}
                  icon={<Building2 className="size-4 shrink-0 text-(--el-icon-muted)" />}
                >
                  {org.login}
                </Option>
              ))}
            </Group>
          ) : null}
        </div>

        {orgs.status === 'loading' ? (
          <p
            role="status"
            className="flex items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-secondary)"
          >
            <Spinner size="sm" aria-hidden />
            {t('orgsLoading')}
          </p>
        ) : null}
      </div>

      {orgs.status === 'loading' ? (
        <p className="text-xs text-(--el-text-helper)">{t('orgsLoadingHint')}</p>
      ) : null}

      {orgs.status === 'failed' ? (
        <Notice tone="info" icon={<Info className="size-5 shrink-0 text-(--el-info)" />} status>
          {t('orgsFailed')}{' '}
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('orgsRetry')}
          </button>
        </Notice>
      ) : null}

      {/* The org target's THIRD-PARTY permission price, stated ONCE under the
          list — not repeated on every org row, and never used to hide the
          option. Panel 7a draws the refusal honestly instead. */}
      <p className="text-xs text-(--el-text-helper)">{t('orgPermissionNote')}</p>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col">
      <span
        aria-hidden="true"
        className="px-(--spacing-control-x) pt-2 pb-1 font-mono text-[11px] tracking-[0.06em] text-(--el-text-eyebrow) uppercase"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/** An option carries a CHECK, not colour alone — the selected row is legible
 *  without hue, and it holds no action button (a `role="option"` cannot). */
function Option({
  selected,
  onSelect,
  icon,
  caption,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
        selected ? 'bg-(--el-option-active-bg)' : 'hover:bg-(--el-surface-soft)'
      }`}
    >
      <span className="inline-flex shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate font-mono text-sm font-semibold text-(--el-text)">
          {children}
        </span>
        {caption ? <span className="text-xs text-(--el-text-helper)">{caption}</span> : null}
      </span>
      {selected ? (
        <Check className="size-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden="true" />
      ) : null}
    </div>
  );
}

function Cost({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="inline-flex" aria-hidden="true">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-(--el-text)">{title}</span>
        <span className="text-sm text-(--el-text-helper)">{children}</span>
      </span>
    </li>
  );
}

function Notice({
  tone,
  icon,
  status,
  children,
}: {
  tone: 'info' | 'soft';
  icon: ReactNode;
  status?: boolean;
  children: ReactNode;
}) {
  const fill =
    tone === 'info'
      ? 'bg-(--el-notice-info-bg) border-(--el-border-soft)'
      : 'bg-(--el-surface-soft) border-(--el-border-soft)';
  return (
    <div
      {...(status ? { role: 'status' } : {})}
      className={`flex gap-3 rounded-(--radius-card) border p-(--spacing-card-padding) ${fill}`}
    >
      <span className="inline-flex" aria-hidden="true">
        {icon}
      </span>
      <p className="min-w-0 text-sm leading-relaxed text-(--el-text-secondary)">{children}</p>
    </div>
  );
}

/** The dialog chrome — one primary per step, never two (§14.6). The heading is
 *  rendered inside the body so the eyebrow can sit above it, so the dialog takes
 *  its accessible name from `srTitle`. */
function Shell({
  onClose,
  eyebrow,
  title,
  footer,
  children,
}: {
  onClose: () => void;
  eyebrow: string;
  title: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} srTitle={title} size="lg">
      {/* `Modal.Footer` is a SIBLING of `Modal.Body`, not a child: that is the
          primitive's pinned-footer recipe, and it keeps the one primary action
          visible while a long costs list scrolls. */}
      <Modal.Body className="gap-4">
        <div className="flex flex-col gap-1">
          <SectionLabel>{eyebrow}</SectionLabel>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">{title}</h2>
        </div>
        {children}
      </Modal.Body>
      <Modal.Footer>{footer}</Modal.Footer>
    </Modal>
  );
}
