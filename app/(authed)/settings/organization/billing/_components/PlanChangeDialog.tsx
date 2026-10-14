'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, ArrowRight, Check, Clock, ExternalLink, Info } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type {
  DowngradePreviewDTO,
  DowngradeResultDTO,
  UpgradePreviewDTO,
  UpgradeResultDTO,
} from '@/lib/dto/billing';
import type { PlanChangeRefusalReason } from '@/lib/ai/errors';
import {
  confirmDowngrade,
  confirmUpgrade,
  previewDowngrade,
  previewUpgrade,
  type PlanChangeOutcome,
} from '@/lib/billing/planChangeClient';
import { fmt, fmtDate, fmtMoney } from './billingFormat';

// The two plan-change dialogs (Story MOTIR-8387 · MOTIR-8399; design
// `billing--upgrade.mock.html`, MOTIR-8397). An org on a live AI plan moves UP
// now — charged for the days left, the extra credits granted for them — or DOWN
// at the period end, with nothing charged, refunded or granted until then.
//
// ⚠️ NO FIGURE, DATE OR AMOUNT IS COMPOSED HERE. Each one is a field of the
// preview or the confirm motir-ai answered, passed through the billing routes;
// this file only formats them. The cadence is the ORG's (the preview prices the
// target on the subscription's own cadence), never the storefront toggle's.

type T = ReturnType<typeof useTranslations>;

/** A plan's display name by key — the catalog's names, which the cards show too. */
export type PlanNames = Record<string, string>;

interface DialogProps {
  orgId: string;
  /** The plan the dialog moves to. */
  toPlanKey: string;
  planNames: PlanNames;
  onClose: () => void;
  /** The plan changed: the page re-reads its billing status. */
  onChanged: () => void;
}

/** What a refusal shows: the alert line, and whether the confirm stays live. */
type Problem =
  | { kind: 'refused'; reason: PlanChangeRefusalReason }
  | { kind: 'forbidden' }
  | { kind: 'error' };

function problemOf<T>(outcome: PlanChangeOutcome<T>): Problem | null {
  return outcome.kind === 'ok' ? null : outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade

type UpgradeFigureKey =
  | 'amountDueCents'
  | 'billingDaysLeft'
  | 'extraCredits'
  | 'extraIndexAllowance';
const UPGRADE_FIGURES: UpgradeFigureKey[] = [
  'amountDueCents',
  'billingDaysLeft',
  'extraCredits',
  'extraIndexAllowance',
];

export function UpgradeDialog({
  orgId,
  toPlanKey,
  planNames,
  onClose,
  onChanged,
  portal,
}: DialogProps & { portal: () => void }) {
  const t = useTranslations('billing.plans');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [preview, setPreview] = useState<UpgradePreviewDTO | null>(null);
  const [previewProblem, setPreviewProblem] = useState<Problem | null>(null);
  const [confirmProblem, setConfirmProblem] = useState<Problem | null>(null);
  const [changed, setChanged] = useState<Set<UpgradeFigureKey> | null>(null);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>('preview');
  const [result, setResult] = useState<UpgradeResultDTO | null>(null);
  const seq = useRef(0);

  // Setting state from a preview answer happens in this callback, never in an
  // effect body: the mount effect hands it the answer from a `.then`.
  const applyPreview = useCallback(
    (
      mySeq: number,
      outcome: Awaited<ReturnType<typeof previewUpgrade>>,
      previous: UpgradePreviewDTO | null,
    ) => {
      if (mySeq !== seq.current) return;
      setBusy(null);
      if (outcome.kind !== 'ok') {
        setPreviewProblem(outcome);
        return;
      }
      setPreviewProblem(null);
      setPreview(outcome.value);
      setChanged(
        previous ? new Set(UPGRADE_FIGURES.filter((k) => previous[k] !== outcome.value[k])) : null,
      );
    },
    [],
  );

  async function loadPreview(previous: UpgradePreviewDTO | null) {
    setBusy('preview');
    const mySeq = ++seq.current;
    applyPreview(mySeq, await previewUpgrade(orgId, toPlanKey), previous);
  }

  useEffect(() => {
    // Price the change once, when the dialog opens — an external read.
    const mySeq = ++seq.current;
    void previewUpgrade(orgId, toPlanKey).then((outcome) => applyPreview(mySeq, outcome, null));
  }, [orgId, toPlanKey, applyPreview]);

  async function confirm() {
    if (!preview) return;
    setBusy('confirm');
    setConfirmProblem(null);
    const outcome = await confirmUpgrade(orgId, toPlanKey, preview.prorationDate);
    if (outcome.kind === 'ok') {
      setBusy(null);
      setResult(outcome.value);
      onChanged();
      return;
    }
    if (outcome.kind === 'refused' && outcome.reason === 'preview_expired') {
      // Not a refusal to show: re-price at a fresh proration date and let the
      // owner confirm what they now see.
      await loadPreview(preview);
      return;
    }
    setBusy(null);
    setConfirmProblem(problemOf(outcome));
  }

  const name = (key: string) => planNames[key] ?? key;
  const locked = busy === 'confirm';
  const close = (open: boolean) => {
    if (!open && !locked) onClose();
  };

  if (result) {
    return (
      <Modal
        open
        onOpenChange={close}
        size="md"
        title={t('upgrade.success', { plan: name(result.toPlan) })}
      >
        <Modal.Body className="gap-3">
          <SuccessGlyph icon={<Check className="h-4 w-4" />} />
          <p className="font-sans text-sm text-(--el-text)" data-testid="plan-change-success">
            {result.extraIndexAllowance === null
              ? t('upgrade.successGrantCredits', { credits: fmt(result.extraCredits, locale) })
              : t('upgrade.successGrant', {
                  credits: fmt(result.extraCredits, locale),
                  allowance: fmt(result.extraIndexAllowance, locale),
                })}
          </p>
          {result.clearedPending ? (
            <p className="font-sans text-sm text-(--el-text)">{t('upgrade.successCleared')}</p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={onClose}>
            {t('upgrade.done')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  const shown = confirmProblem ?? previewProblem;
  const paymentFailed = shown?.kind === 'refused' && shown.reason === 'payment_failed';
  // The confirm stays live to retry a declined card and a failed send; every other
  // refusal (and a preview that could not be priced) disables it.
  const confirmBlocked =
    !preview ||
    !!previewProblem ||
    (!!confirmProblem && !paymentFailed && confirmProblem.kind !== 'error');
  const dismissLabel = shown && confirmBlocked ? tc('close') : t('upgrade.cancel');
  const changedOf = (k: UpgradeFigureKey) => !!changed?.has(k);

  return (
    <Modal
      open
      onOpenChange={close}
      size="md"
      title={t('upgrade.title', { plan: name(toPlanKey) })}
      hideClose={locked}
    >
      <Modal.Body className="gap-4" aria-busy={busy !== null}>
        {busy === 'preview' && !preview ? (
          <PreviewSkeleton label={t('upgrade.title', { plan: name(toPlanKey) })} />
        ) : null}
        {previewProblem && !preview ? (
          <PreviewProblem
            t={t}
            problem={previewProblem}
            planName={name(toPlanKey)}
            kind="upgrade"
          />
        ) : null}
        {preview ? (
          <>
            <PlanSwitch
              t={t}
              from={name(preview.fromPlan)}
              to={name(preview.toPlan)}
              fromPool={fmt(preview.fromPool, locale)}
              toPool={fmt(preview.fullPool, locale)}
            />
            {changed && changed.size > 0 ? (
              <Notice tone="changed">{t('upgrade.previewChanged')}</Notice>
            ) : null}
            <Section label={t('upgrade.dueToday')}>
              <p className="font-serif text-[28px] leading-tight text-(--el-text)">
                <Figure changed={changedOf('amountDueCents')}>
                  {fmtMoney(preview.amountDueCents, preview.currency, locale)}
                </Figure>
              </p>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('upgrade.daysLeft', {
                  n: preview.billingDaysLeft,
                  date: fmtDate(preview.periodEnd, locale) ?? '—',
                })}
              </p>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('upgrade.proration')}
              </p>
            </Section>
            <Section label={t('upgrade.creditsNowLabel')}>
              <GrantLine changed={changedOf('extraCredits')}>
                {t('upgrade.extraCredits', { n: fmt(preview.extraCredits, locale) })}
              </GrantLine>
              {preview.extraIndexAllowance !== null ? (
                <GrantLine changed={changedOf('extraIndexAllowance')}>
                  {t('upgrade.extraAllowance', { n: fmt(preview.extraIndexAllowance, locale) })}
                </GrantLine>
              ) : null}
              {preview.cadence === 'annual' ? (
                <p
                  className="font-sans text-xs text-(--el-text-secondary)"
                  data-testid="plan-change-credit-window"
                >
                  {t('upgrade.creditWindow', {
                    n: preview.daysLeft,
                    date: fmtDate(preview.creditWindowEnd, locale) ?? '—',
                    credits: fmt(preview.fullPool, locale),
                  })}
                </p>
              ) : null}
            </Section>
            <p className="font-sans text-sm text-(--el-text)">
              <RenewalLine
                t={t}
                kind="upgrade"
                date={fmtDate(preview.periodEnd, locale) ?? '—'}
                plan={name(preview.toPlan)}
                price={fmtMoney(preview.toPriceCents, preview.currency, locale)}
                cadence={preview.cadence}
                credits={fmt(preview.fullPool, locale)}
                allowance={
                  preview.fullAllowance === null ? null : fmt(preview.fullAllowance, locale)
                }
              />
            </p>
            {preview.pendingDowngrade ? (
              <InfoRow>
                {t('upgrade.clearsPending', {
                  plan: name(preview.pendingDowngrade.planKey),
                  date: fmtDate(preview.pendingDowngrade.effectiveDate, locale) ?? '—',
                })}
              </InfoRow>
            ) : null}
            {preview.cadenceChange ? (
              <InfoRow>
                {t('upgrade.cadenceChange', {
                  from: t(preview.cadenceChange.from),
                  to: t(preview.cadenceChange.to),
                })}
              </InfoRow>
            ) : null}
            {confirmProblem ? (
              <ProblemBox>{problemText(t, confirmProblem, name(toPlanKey), 'upgrade')}</ProblemBox>
            ) : null}
            <p className="font-sans text-xs text-(--el-text-secondary)">{t('upgrade.footnote')}</p>
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={locked}>
          {dismissLabel}
        </Button>
        {previewProblem && !preview ? (
          <Button
            variant="secondary"
            onClick={() => void loadPreview(null)}
            loading={busy === 'preview'}
          >
            {tc('retry')}
          </Button>
        ) : null}
        {paymentFailed ? (
          <Button
            variant="secondary"
            onClick={portal}
            disabled={locked}
            leftIcon={<ExternalLink className="h-4 w-4" />}
          >
            {t('managePlan')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void confirm()}
          loading={locked}
          disabled={confirmBlocked || busy === 'preview'}
        >
          {confirmProblem?.kind === 'error' ? tc('retry') : t('upgrade.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Downgrade

export function DowngradeDialog({ orgId, toPlanKey, planNames, onClose, onChanged }: DialogProps) {
  const t = useTranslations('billing.plans');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [preview, setPreview] = useState<DowngradePreviewDTO | null>(null);
  const [previewProblem, setPreviewProblem] = useState<Problem | null>(null);
  const [confirmProblem, setConfirmProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>('preview');
  const [result, setResult] = useState<DowngradeResultDTO | null>(null);
  const seq = useRef(0);

  const applyPreview = useCallback(
    (mySeq: number, outcome: Awaited<ReturnType<typeof previewDowngrade>>) => {
      if (mySeq !== seq.current) return;
      setBusy(null);
      if (outcome.kind !== 'ok') {
        setPreviewProblem(outcome);
        return;
      }
      setPreviewProblem(null);
      setPreview(outcome.value);
    },
    [],
  );

  async function loadPreview() {
    setBusy('preview');
    const mySeq = ++seq.current;
    applyPreview(mySeq, await previewDowngrade(orgId, toPlanKey));
  }

  useEffect(() => {
    const mySeq = ++seq.current;
    void previewDowngrade(orgId, toPlanKey).then((outcome) => applyPreview(mySeq, outcome));
  }, [orgId, toPlanKey, applyPreview]);

  async function confirm() {
    setBusy('confirm');
    setConfirmProblem(null);
    const outcome = await confirmDowngrade(orgId, toPlanKey);
    setBusy(null);
    if (outcome.kind === 'ok') {
      setResult(outcome.value);
      onChanged();
      return;
    }
    setConfirmProblem(problemOf(outcome));
  }

  const name = (key: string) => planNames[key] ?? key;
  const locked = busy === 'confirm';
  const close = (open: boolean) => {
    if (!open && !locked) onClose();
  };

  if (result) {
    return (
      <Modal open onOpenChange={close} size="md" title={t('downgrade.success')}>
        <Modal.Body className="gap-3">
          <SuccessGlyph icon={<Clock className="h-4 w-4" />} />
          <p className="font-sans text-sm text-(--el-text)" data-testid="plan-change-success">
            {result.status === 'scheduled'
              ? t('downgrade.successBody', {
                  current: name(result.fromPlan),
                  date: fmtDate(result.effectiveDate, locale) ?? '—',
                  plan: name(result.toPlan),
                })
              : t('upgrade.refusedSame', { plan: name(result.toPlan) })}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={onClose}>
            {t('downgrade.done')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  // Choosing the plan already scheduled is answered from the preview: a stale tab,
  // since the card itself shows "Scheduled for …" and cannot open this dialog.
  const alreadyScheduled =
    preview?.pendingDowngrade?.planKey === toPlanKey ? preview.pendingDowngrade : null;
  const confirmBlocked =
    !preview ||
    !!previewProblem ||
    !!alreadyScheduled ||
    (!!confirmProblem && confirmProblem.kind !== 'error');
  const shown = confirmProblem ?? previewProblem ?? (alreadyScheduled ? true : null);
  const dismissLabel = shown && confirmBlocked ? tc('close') : t('downgrade.cancel');

  return (
    <Modal
      open
      onOpenChange={close}
      size="md"
      title={t('downgrade.title', { plan: name(toPlanKey) })}
      hideClose={locked}
    >
      <Modal.Body className="gap-4" aria-busy={busy !== null}>
        {busy === 'preview' && !preview ? (
          <PreviewSkeleton label={t('downgrade.title', { plan: name(toPlanKey) })} />
        ) : null}
        {previewProblem && !preview ? (
          <PreviewProblem
            t={t}
            problem={previewProblem}
            planName={name(toPlanKey)}
            kind="downgrade"
          />
        ) : null}
        {preview ? (
          <>
            <PlanSwitch
              t={t}
              from={name(preview.fromPlan)}
              to={name(preview.toPlan)}
              fromPool={fmt(preview.fromPool, locale)}
              toPool={fmt(preview.fullPool, locale)}
            />
            <Section label={t('downgrade.takesEffectLabel')}>
              <p className="font-sans text-sm text-(--el-text)">
                {t('downgrade.takesEffect', {
                  date: fmtDate(preview.effectiveDate, locale) ?? '—',
                })}
              </p>
            </Section>
            <Section label={t('upgrade.dueToday')}>
              <p className="font-sans text-[15px] font-semibold text-(--el-text)">
                {t('downgrade.dueToday')}
              </p>
            </Section>
            <Section label={t('downgrade.creditsNowLabel')}>
              <p className="font-sans text-sm text-(--el-text)">
                {t('downgrade.creditsStay', { plan: name(preview.fromPlan) })}
              </p>
            </Section>
            <p className="font-sans text-sm text-(--el-text)">
              <RenewalLine
                t={t}
                kind="downgrade"
                date={fmtDate(preview.effectiveDate, locale) ?? '—'}
                plan={name(preview.toPlan)}
                price={fmtMoney(preview.toPriceCents, preview.currency, locale)}
                cadence={preview.cadence}
                credits={fmt(preview.fullPool, locale)}
                allowance={
                  preview.fullAllowance === null ? null : fmt(preview.fullAllowance, locale)
                }
              />
            </p>
            {preview.pendingDowngrade && !alreadyScheduled ? (
              <InfoRow>
                {t('downgrade.replaces', {
                  plan: name(preview.pendingDowngrade.planKey),
                  date: fmtDate(preview.pendingDowngrade.effectiveDate, locale) ?? '—',
                })}
              </InfoRow>
            ) : null}
            {alreadyScheduled ? (
              <ProblemBox>
                {t('downgrade.refusedScheduled', {
                  date: fmtDate(alreadyScheduled.effectiveDate, locale) ?? '—',
                })}
              </ProblemBox>
            ) : null}
            {confirmProblem ? (
              <ProblemBox>
                {problemText(t, confirmProblem, name(toPlanKey), 'downgrade')}
              </ProblemBox>
            ) : null}
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('downgrade.footnote')}
            </p>
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={locked}>
          {dismissLabel}
        </Button>
        {previewProblem && !preview ? (
          <Button
            variant="secondary"
            onClick={() => void loadPreview()}
            loading={busy === 'preview'}
          >
            {tc('retry')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void confirm()}
          loading={locked}
          disabled={confirmBlocked || busy === 'preview'}
        >
          {confirmProblem?.kind === 'error' ? tc('retry') : t('downgrade.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parts

/** The alert line for a refusal (design § Refusals); unknown codes are the error state. */
function problemText(
  t: T,
  problem: Problem,
  planName: string,
  kind: 'upgrade' | 'downgrade',
): string {
  if (problem.kind === 'forbidden') return t('upgrade.refusedRole');
  if (problem.kind === 'refused') {
    switch (problem.reason) {
      case 'not_an_upgrade':
        return t('upgrade.refusedNotHigher');
      case 'not_a_downgrade':
        return t('downgrade.refusedNotLower');
      case 'same_plan':
        return t('upgrade.refusedSame', { plan: planName });
      case 'payment_failed':
        return t('upgrade.refusedPayment');
      case 'no_live_plan':
        return t('upgrade.refusedNoPlan');
      default:
        break;
    }
  }
  return t(`${kind}.error`);
}

function PreviewProblem({
  t,
  problem,
  planName,
  kind,
}: {
  t: T;
  problem: Problem;
  planName: string;
  kind: 'upgrade' | 'downgrade';
}) {
  // A preview the server could not price is the "couldn't price" state with Try
  // again; a refusal it answered is that refusal's line.
  const text =
    problem.kind === 'error' ? t('upgrade.previewError') : problemText(t, problem, planName, kind);
  return <ProblemBox>{text}</ProblemBox>;
}

function PlanSwitch({
  t,
  from,
  to,
  fromPool,
  toPool,
}: {
  t: T;
  from: string;
  to: string;
  fromPool: string;
  toPool: string;
}) {
  return (
    <div
      role="group"
      aria-label={t('upgrade.switch', { from, to })}
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding) sm:flex-row sm:items-center sm:justify-between"
      data-testid="plan-change-switch"
    >
      <div className="flex min-w-0 flex-col">
        <span className="font-sans text-sm font-semibold text-(--el-text)">{from}</span>
        <span className="font-sans text-xs text-(--el-text-secondary)">
          {t('upgrade.poolLine', { n: fromPool })}
        </span>
      </div>
      <ArrowRight
        className="h-4 w-4 shrink-0 rotate-90 text-(--el-text-secondary) sm:rotate-0"
        aria-hidden
      />
      <div className="flex min-w-0 flex-col sm:items-end">
        <span className="font-sans text-sm font-semibold text-(--el-text)">{to}</span>
        <span className="font-sans text-xs text-(--el-text-secondary)">
          {t('upgrade.poolLine', { n: toPool })}
        </span>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1" aria-label={label}>
      <h3 className="font-sans text-xs font-semibold text-(--el-text-secondary)">{label}</h3>
      {children}
    </section>
  );
}

function GrantLine({ changed, children }: { changed?: boolean; children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 font-sans text-sm text-(--el-text)">
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
      <Figure changed={changed}>{children}</Figure>
    </p>
  );
}

/** A figure the re-read preview changed is marked (design panel 8c). */
function Figure({ changed, children }: { changed?: boolean; children: ReactNode }) {
  if (!changed) return <span className="font-semibold">{children}</span>;
  return (
    <mark
      data-changed="true"
      className="rounded-(--radius-control) bg-(--el-tint-yellow) px-1 font-semibold text-(--el-text-strong)"
    >
      {children}
    </mark>
  );
}

function RenewalLine({
  t,
  kind,
  date,
  plan,
  price,
  cadence,
  credits,
  allowance,
}: {
  t: T;
  kind: 'upgrade' | 'downgrade';
  date: string;
  plan: string;
  price: string;
  cadence: 'monthly' | 'annual';
  credits: string;
  allowance: string | null;
}) {
  const per = t(`upgrade.per.${cadence}`);
  const [full, noAllowance] =
    kind === 'upgrade'
      ? ['upgrade.renewal', 'upgrade.renewalNoAllowance']
      : ['downgrade.from', 'downgrade.fromNoAllowance'];
  return allowance === null
    ? t(noAllowance, { date, plan, price, cadence: per, credits })
    : t(full, { date, plan, price, cadence: per, credits, allowance });
}

function InfoRow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-text)">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-text-secondary)" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Notice({ children }: { tone: 'changed'; children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-text-strong)"
    >
      {children}
    </p>
  );
}

/** `FormField`'s `errorVariant="box"` alert, reused for refusals and errors. */
function ProblemBox({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-danger-surface) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-danger-surface-text)"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

function SuccessGlyph({ icon }: { icon: ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--el-tint-mint) text-(--el-text-strong)"
    >
      {icon}
    </span>
  );
}

function PreviewSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col gap-3"
      role="status"
      aria-label={label}
      data-testid="plan-change-loading"
    >
      {[60, 40, 80, 70].map((w, i) => (
        <span
          key={i}
          aria-hidden
          className="block h-4 rounded-(--radius-control) bg-(--el-muted)"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}
