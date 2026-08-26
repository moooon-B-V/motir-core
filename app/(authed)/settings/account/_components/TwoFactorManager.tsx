'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Info,
  KeyRound,
  Mail,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { twoFactor } from '@/lib/auth/client';
import type { TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// The account Security pane's interactive half (Story 8.11 · Subtask
// MOTIR-1220), built to `design/settings/two-factor.mock.html`.
//
// ── WHY THIS IS A CLIENT ISLAND THAT OWNS ITS OWN STATUS ──────────────────
// CLAUDE.md's page-state-after-mutation contract, case 3. This component seeds
// `useState(initialStatus)` from a server read, so `router.refresh()` CANNOT
// reach it — the initializer runs once at mount and re-rendered server props are
// ignored. Every mutation here therefore updates the island explicitly, from the
// RESPONSE it just received, and nothing calls `router.refresh()`. There is no
// second surface on this page for a refresh to be needed by.
//
// ── THE STEP-UP, AND WHY IT IS A GATE RATHER THAN A FIELD ─────────────────
// Three actions are password-gated by Better-Auth — enable, generate-backup-codes
// and disable — so the password is collected ONCE, by `runGated`, and handed to
// whichever action asked for it. `hasPassword` decides whether the gate renders
// at all: with `allowPasswordless: true` (MOTIR-1217) an account with no
// credential row is not asked, because it has no password to be asked for.
//
// ⚠️ For ENROL the ORDER is forced, not chosen: `twoFactor.enable` is the call
// that MINTS the secret and returns the `totpURI`, so the password must be
// collected BEFORE there is a QR to draw. The design's three-step rail
// (Confirm → Scan → Enter code) is that fact, not a layout preference.

type Method = TwoFactorStatusDTO['methods'][number];

/** Which flow the shared step-up modal is currently gating. */
type Gated = 'enable' | 'regenerate' | 'disable';

interface Props {
  initialStatus: TwoFactorStatusDTO;
  email: string;
  hasPassword: boolean;
  backupCodeCount: number;
  otpPeriodMinutes: number;
  totpPeriodSeconds: number;
  /**
   * How long "don't ask again on this device" lasts. Threaded through now and
   * consumed by MOTIR-1221, which owns both the checkbox that creates a trusted
   * device and the list that revokes one — the design draws that card on THIS
   * pane, but the rows are `verification` `trust-device-*` entries and no read
   * exposes them yet. Named here rather than dropped so the gap is visible at
   * the seam instead of being rediscovered from the mock.
   */
  trustDeviceDays: number;
}

export function TwoFactorManager({
  initialStatus,
  email,
  hasPassword,
  backupCodeCount,
  otpPeriodMinutes,
  totpPeriodSeconds,
}: Props) {
  const t = useTranslations('settings.account.twoFactor');

  const [status, setStatus] = useState<TwoFactorStatusDTO>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The step-up gate. `gating` names the action waiting on a password.
  const [gating, setGating] = useState<Gated | null>(null);
  const [password, setPassword] = useState('');

  // Enrolment, once `enable` has returned. `totpUri` is what the QR encodes;
  // `pendingCodes` are the recovery codes `enable` handed back — HELD here
  // across the confirm step, because there is no endpoint to re-read them from.
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [pendingCodes, setPendingCodes] = useState<string[] | null>(null);
  const [confirmCode, setConfirmCode] = useState('');

  // The shown-once set, after a confirm or a regenerate.
  const [shownCodes, setShownCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const reset = useCallback(() => {
    setPassword('');
    setConfirmCode('');
    setError('');
  }, []);

  /**
   * Open the step-up for `action`, or run it straight away when the account has
   * no password. The two arms are the same flow; only the prompt differs.
   */
  const request = useCallback(
    (action: Gated) => {
      reset();
      if (hasPassword) {
        setGating(action);
        return;
      }
      void run(action, undefined);
    },
    // `run` is declared below and is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasPassword, reset],
  );

  async function run(action: Gated, pw: string | undefined) {
    setBusy(true);
    setError('');
    try {
      if (action === 'enable') {
        const res = await twoFactor.enable({ password: pw ?? '' });
        if (res.error) throw new Error(res.error.message ?? 'enable failed');
        setTotpUri(res.data?.totpURI ?? null);
        setPendingCodes(res.data?.backupCodes ?? null);
        setGating(null);
        return;
      }
      if (action === 'regenerate') {
        // Motir's own route, not the plugin's: it takes the row lock that makes
        // a regenerate racing a spend safe (MOTIR-1218).
        const res = await fetch('/api/account/two-factor/backup-codes', { method: 'POST' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { codes: string[]; remaining: number };
        setShownCodes(body.codes);
        setAcknowledged(false);
        setStatus((s) => ({ ...s, backupCodesRemaining: body.remaining }));
        setGating(null);
        return;
      }
      const res = await twoFactor.disable({ password: pw ?? '' });
      if (res.error) throw new Error(res.error.message ?? 'disable failed');
      setStatus({
        enabled: false,
        methods: [],
        primaryMethod: null,
        backupCodesRemaining: 0,
        backupCodesTotal: backupCodeCount,
      });
      setGating(null);
    } catch {
      // One message for all three gated actions, deliberately: the only failure
      // a reader can act on differently is a wrong password, and Better-Auth
      // answers that with the same INVALID_PASSWORD it answers a missing one
      // with — so a per-action message would be inventing a distinction the
      // response does not carry.
      setError(t('errors.wrongPassword'));
    } finally {
      setBusy(false);
    }
  }

  /** Step 3 — the confirming code is what actually turns 2FA on. */
  async function confirmEnrolment() {
    setBusy(true);
    setError('');
    try {
      const res = await twoFactor.verifyTotp({ code: confirmCode });
      if (res.error) throw new Error(res.error.message ?? 'verify failed');
      setTotpUri(null);
      setShownCodes(pendingCodes);
      setPendingCodes(null);
      setAcknowledged(false);
      setConfirmCode('');
      setStatus({
        enabled: true,
        methods: ['totp', 'email'],
        primaryMethod: 'totp',
        backupCodesRemaining: backupCodeCount,
        backupCodesTotal: backupCodeCount,
      });
    } catch {
      setError(t('errors.wrongCode'));
    } finally {
      setBusy(false);
    }
  }

  const remaining = status.backupCodesRemaining;
  const counterTone =
    remaining === 0
      ? 'text-(--el-danger)'
      : remaining <= 2
        ? 'text-(--el-warning)'
        : 'text-(--el-text)';

  return (
    <div className="flex flex-col gap-6">
      {status.enabled ? (
        <MethodsCard
          status={status}
          email={email}
          otpPeriodMinutes={otpPeriodMinutes}
          onSetUp={() => request('enable')}
        />
      ) : (
        <>
          <Card>
            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-(--el-tint-lavender) text-(--el-accent-on-surface)">
                <ShieldCheck className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="font-sans text-base font-semibold text-(--el-text)">
                {t('off.title')}
              </h3>
              <p className="max-w-[46ch] font-sans text-sm leading-relaxed text-(--el-text-secondary)">
                {t('off.body')}
              </p>
              <Button variant="primary" onClick={() => request('enable')} loading={busy}>
                <Smartphone className="h-4 w-4" aria-hidden />
                {t('off.cta')}
              </Button>
            </div>
          </Card>
          <MethodsCard
            status={status}
            email={email}
            otpPeriodMinutes={otpPeriodMinutes}
            onSetUp={() => request('enable')}
          />
        </>
      )}

      {status.enabled ? (
        <>
          <Card
            header={
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-sans text-[15px] font-semibold text-(--el-text)">
                    {t('recovery.title')}
                  </h3>
                  <p className="mt-1 font-sans text-xs text-(--el-text-muted)">
                    {t('recovery.subtitle')}
                  </p>
                </div>
                <div className="flex shrink-0 items-baseline gap-2">
                  <span className={`font-mono text-3xl leading-none font-semibold ${counterTone}`}>
                    {remaining}
                  </span>
                  <span className="font-sans text-xs text-(--el-text-secondary)">
                    {t('recovery.remaining', { total: status.backupCodesTotal })}
                  </span>
                </div>
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              {remaining === 0 ? (
                <Callout tone="danger">{t('recovery.exhausted')}</Callout>
              ) : remaining <= 2 ? (
                <Callout tone="warn">{t('recovery.low', { remaining })}</Callout>
              ) : null}
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <div className="font-sans text-sm font-medium text-(--el-text)">
                    {t('recovery.generateTitle')}
                  </div>
                  <p className="mt-0.5 max-w-[46ch] font-sans text-xs leading-relaxed text-(--el-text-muted)">
                    {t('recovery.generateDesc')}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => request('regenerate')}
                  loading={busy}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t('recovery.generate')}
                </Button>
              </div>
            </div>
          </Card>

          <Card
            header={
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-sans text-[15px] font-semibold text-(--el-text)">
                    {t('disable.title')}
                  </h3>
                  <p className="mt-1 max-w-[46ch] font-sans text-xs leading-relaxed text-(--el-text-muted)">
                    {t('disable.subtitle')}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => request('disable')}>
                  <span className="text-(--el-danger)">{t('disable.cta')}</span>
                </Button>
              </div>
            }
          />
        </>
      ) : null}

      {error && !gating && !totpUri ? <Callout tone="danger">{error}</Callout> : null}

      {/* ── The shared step-up ─────────────────────────────────────────────── */}
      <Modal
        open={gating !== null}
        onOpenChange={(open) => {
          if (!open) {
            setGating(null);
            reset();
          }
        }}
        title={gating === 'disable' ? t('disable.confirmTitle') : t('stepUp.title')}
        description={gating === 'disable' ? t('disable.confirmSubtitle') : t('stepUp.subtitle')}
      >
        <Modal.Body>
          <div className="flex flex-col gap-4">
            {gating === 'disable' ? <Callout tone="danger">{t('disable.warning')}</Callout> : null}
            {gating === 'regenerate' ? (
              <Callout tone="danger">{t('regenerate.warning')}</Callout>
            ) : null}
            <Input
              type="password"
              label={t('stepUp.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error || undefined}
              autoComplete="current-password"
              autoFocus
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setGating(null)}>
            {t('enrol.cancel')}
          </Button>
          <Button
            variant={gating === 'enable' ? 'primary' : 'danger'}
            loading={busy}
            onClick={() => gating && void run(gating, password)}
          >
            {gating === 'disable'
              ? t('disable.confirm')
              : gating === 'regenerate'
                ? t('regenerate.confirm')
                : t('stepUp.continue')}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* ── Enrol, steps 2 and 3 ───────────────────────────────────────────── */}
      <Modal
        open={totpUri !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTotpUri(null);
            setPendingCodes(null);
            reset();
          }
        }}
        title={t('enrol.scanTitle')}
        description={t('enrol.scanSubtitle')}
      >
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <EnrolSteps
              current={2}
              labels={[t('enrol.stepConfirm'), t('enrol.stepScan'), t('enrol.stepCode')]}
            />
            <div className="flex flex-col gap-1.5">
              <span className="font-sans text-sm font-medium text-(--el-text)">
                {t('enrol.cantScan')}
              </span>
              <span className="font-sans text-xs text-(--el-text-muted)">
                {t('enrol.cantScanHelp')}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-(--radius-input) border border-(--el-border) px-3 py-2">
              <code className="min-w-0 flex-1 font-mono text-xs break-all text-(--el-text)">
                {secretFromUri(totpUri)}
              </code>
              <button
                type="button"
                aria-label={t('enrol.copyKey')}
                onClick={() => void navigator.clipboard?.writeText(secretFromUri(totpUri))}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
              >
                <Copy className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <Input
              label={t('enrol.codeLabel')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, ''))}
              error={error || undefined}
              className="font-mono tracking-[0.4em]"
            />
            <Callout tone="info">{t('enrol.codesNext')}</Callout>
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('enrol.codeSubtitle', { seconds: totpPeriodSeconds })}
            </p>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setTotpUri(null)}>
            {t('enrol.back')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={confirmCode.length !== 6}
            onClick={() => void confirmEnrolment()}
          >
            {t('enrol.turnOn')}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* ── The shown-once recovery codes ──────────────────────────────────── */}
      <Modal
        open={shownCodes !== null}
        onOpenChange={(open) => {
          // Dismissal is gated on the acknowledgement: this is the only time the
          // plaintext exists, and a reader who closes modals by reflex would
          // otherwise lose it silently.
          if (!open && acknowledged) setShownCodes(null);
        }}
        hideClose
        title={t('codes.title')}
        description={t('codes.subtitle')}
      >
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-(--radius-input) border border-(--el-border) px-4 py-4">
              {(shownCodes ?? []).map((code) => (
                <code key={code} className="font-mono text-sm text-(--el-text)">
                  {code}
                </code>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText((shownCodes ?? []).join('\n'))}
              >
                <Copy className="h-4 w-4" aria-hidden />
                {t('codes.copyAll')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => downloadCodes(shownCodes ?? [])}>
                <Download className="h-4 w-4" aria-hidden />
                {t('codes.download')}
              </Button>
            </div>
            <Callout tone="warn">{t('codes.warning')}</Callout>
            <Checkbox
              checked={acknowledged}
              onChange={setAcknowledged}
              label={t('codes.acknowledge')}
              labelVisible
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" disabled={!acknowledged} onClick={() => setShownCodes(null)}>
            {t('codes.done')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

/** The methods card — shared by the on and off states, which differ only in copy. */
function MethodsCard({
  status,
  email,
  otpPeriodMinutes,
  onSetUp,
}: {
  status: TwoFactorStatusDTO;
  email: string;
  otpPeriodMinutes: number;
  onSetUp: () => void;
}) {
  const t = useTranslations('settings.account.twoFactor');
  const on = status.enabled;
  const hasTotp = status.methods.includes('totp' as Method);

  return (
    <Card
      header={
        <div>
          <h3 className="flex items-center gap-2 font-sans text-[15px] font-semibold text-(--el-text)">
            {on ? t('methods.title') : t('methods.titleOff')}
            {on ? (
              <Pill status="done">
                <Check className="h-3 w-3" aria-hidden />
                {t('methods.on')}
              </Pill>
            ) : null}
          </h3>
          <p className="mt-1 font-sans text-xs text-(--el-text-muted)">
            {on ? t('methods.subtitle') : t('methods.subtitleOff')}
          </p>
        </div>
      }
    >
      <div className="flex flex-col">
        <MethodRow
          icon={<Smartphone className="h-[18px] w-[18px]" aria-hidden />}
          active={hasTotp}
          name={t('methods.totp.name')}
          badge={hasTotp ? <Pill status="planned">{t('methods.primary')}</Pill> : null}
          desc={hasTotp ? t('methods.totp.descOn') : t('methods.totp.desc')}
          control={
            <Button variant={hasTotp ? 'ghost' : 'secondary'} size="sm" onClick={onSetUp}>
              {hasTotp ? (
                <>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t('methods.totp.replace')}
                </>
              ) : (
                t('methods.totp.setUp')
              )}
            </Button>
          }
        />
        <MethodRow
          icon={<Mail className="h-[18px] w-[18px]" aria-hidden />}
          active={on}
          name={t('methods.email.name')}
          badge={
            <Pill severity="warning">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {t('methods.lowerSecurity')}
            </Pill>
          }
          desc={
            on
              ? t('methods.email.descOn', { email, minutes: otpPeriodMinutes })
              : t('methods.email.desc', { email })
          }
          // ⚠️ A STATE, NOT A TOGGLE — and that is a plugin fact, not a
          // simplification. Better-Auth's OTP arm is SERVER-LEVEL: "if sendOTP
          // is configured, any user with 2fa enabled can receive a code"
          // (plugins/two-factor/index.mjs). There is no per-user enable, and
          // nothing in the schema stores one, so a switch here would be a
          // control that writes nowhere. See the PR body / MOTIR-1220.
          control={
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {on ? t('methods.email.available') : t('methods.email.unavailable')}
            </span>
          }
        />
        {on ? null : (
          <MethodRow
            icon={<KeyRound className="h-[18px] w-[18px]" aria-hidden />}
            active={false}
            name={t('methods.backup.name')}
            desc={t('methods.backup.desc')}
            control={<span className="font-sans text-sm text-(--el-text-secondary)">—</span>}
          />
        )}
      </div>
    </Card>
  );
}

function MethodRow({
  icon,
  active,
  name,
  badge,
  desc,
  control,
}: {
  icon: React.ReactNode;
  active: boolean;
  name: string;
  badge?: React.ReactNode;
  desc: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 border-b border-(--el-border-soft) py-4 last:border-b-0">
      <span
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control) ${
          active
            ? 'bg-(--el-tint-mint) text-(--el-success)'
            : 'bg-(--el-muted) text-(--el-text-secondary)'
        }`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
          {name}
          {badge}
        </div>
        <p className="mt-0.5 max-w-[52ch] font-sans text-xs leading-relaxed text-(--el-text-muted)">
          {desc}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{control}</div>
    </div>
  );
}

function EnrolSteps({ current, labels }: { current: number; labels: string[] }) {
  return (
    <div className="flex items-center gap-2" aria-hidden>
      {labels.map((label, i) => (
        <span key={label} className="flex flex-1 items-center gap-2">
          <span
            className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-full font-sans text-[11px] font-semibold ${
              i + 1 === current
                ? 'bg-(--el-accent) text-(--el-accent-text)'
                : 'bg-(--el-muted) text-(--el-text-secondary)'
            }`}
          >
            {i + 1}
          </span>
          <span
            className={`font-sans text-xs ${
              i + 1 === current ? 'font-medium text-(--el-text)' : 'text-(--el-text-secondary)'
            }`}
          >
            {label}
          </span>
          {i < labels.length - 1 ? <span className="h-px flex-1 bg-(--el-border)" /> : null}
        </span>
      ))}
    </div>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'danger';
  children: React.ReactNode;
}) {
  const bg =
    tone === 'info'
      ? 'bg-(--el-tint-sky)'
      : tone === 'warn'
        ? 'bg-(--el-tint-peach)'
        : 'bg-(--el-tint-rose)';
  const ink =
    tone === 'info'
      ? 'text-(--el-info)'
      : tone === 'warn'
        ? 'text-(--el-warning)'
        : 'text-(--el-danger)';
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={`flex items-start gap-2.5 rounded-(--radius-card) px-3.5 py-3 ${bg}`}>
      <Icon className={`mt-px h-[18px] w-[18px] shrink-0 ${ink}`} aria-hidden />
      <p className="font-sans text-sm leading-relaxed text-(--el-text-strong)">{children}</p>
    </div>
  );
}

/**
 * The Base32 secret out of an `otpauth://` URI, for the manual-entry row.
 * Falls back to the whole URI when the shape is unexpected — showing something
 * the reader can paste beats showing nothing.
 */
function secretFromUri(uri: string | null): string {
  if (!uri) return '';
  const secret = new URL(uri.replace('otpauth://', 'https://')).searchParams.get('secret');
  return secret ?? uri;
}

/** Hand the codes over as a file. A blob URL, revoked on the next tick. */
function downloadCodes(codes: string[]): void {
  const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'motir-recovery-codes.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
