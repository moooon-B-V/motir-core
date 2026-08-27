'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Clock, Cloud, Fingerprint, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { passkey } from '@/lib/auth/client';
import { PASSKEY_CHALLENGE_TTL_MINUTES, PASSKEY_NAME_MAX_LENGTH } from '@/lib/auth/passkeyConfig';
import type { PasskeyDTO } from '@/lib/dto/passkey';

// The account Security pane's PASSKEYS card (Story 8.12 · Subtask MOTIR-3612),
// built to `design/settings/passkeys.mock.html`.
//
// ── WHY IT IS ITS OWN CARD ────────────────────────────────────────────────
// Not a third row inside "What you'll be asked for", and that is the story's
// decision rather than a layout preference: a passkey REPLACES the password, it
// does not follow it, and a screen that files it under "second factor" teaches
// the reader they still need the authenticator app. The methods list still gains
// a READ-ONLY `Passkey` row pointing back up here (`TwoFactorManager`'s
// `MethodsCard`) — the account holds the method, it just is not managed there.
//
// ── STATE: CONTROLLED, and deliberately not its own ───────────────────────
// This component owns NO passkey list. It takes `passkeys` and reports every
// change through `onPasskeysChange`, because the passkey count is also what puts
// `'passkey'` into `TwoFactorStatusDTO.methods` — which two surfaces on this page
// render. `AccountSecurityPanes` is the single owner; see its header for why the
// state was lifted rather than duplicated.
//
// Every mutation updates from the RESPONSE it just received rather than
// re-reading: the island contract `TwoFactorManager` established, and the reason
// no `router.refresh()` appears on this page.
//
// ── THE CEREMONY IS THE PLUGIN'S ──────────────────────────────────────────
// `passkey.addPasskey()` runs generate-register-options → the BROWSER's own
// WebAuthn sheet → verify-registration. Nothing here builds options, computes a
// challenge, or imports `@simplewebauthn`. The sheet in the middle is the
// operating system's surface: we cannot style it, position it, or read from it,
// which is why the pending state below is a row in this card and not a modal —
// stacking our own dialog under the OS sheet would be two overlays for one act.

interface Props {
  passkeys: PasskeyDTO[];
  onPasskeysChange: (next: PasskeyDTO[]) => void;
}

/** Which modal is open, and over which row. */
type Dialog = { kind: 'rename' | 'remove'; passkey: PasskeyDTO } | null;

/**
 * The reader-visible refusals.
 *
 * ⚠️ TWO CODE SPACES REACH THIS MAP, and only one of them is
 * `PASSKEY_ERROR_CODES`. A failure inside the browser ceremony is surfaced by the
 * plugin's client with SimpleWebAuthn's `WebAuthnError.code` verbatim
 * (`ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED`, `ERROR_CEREMONY_ABORTED`); a
 * failure from the SERVER carries the plugin's own key (`CHALLENGE_NOT_FOUND`).
 * Reading only the second set — which is the set the plugin documents — is how a
 * dismissed sheet ends up rendering a generic error banner.
 *
 * `null` means DRAW NOTHING. Dismissing your own browser's prompt is a decision,
 * not a failure, and a red banner there tells someone they did something wrong
 * when they did not.
 */
type NoticeKey = 'previouslyRegistered' | 'challengeExpired' | 'generic' | '';

const ERROR_COPY: Record<string, Exclude<NoticeKey, 'generic' | ''> | null> = {
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'previouslyRegistered',
  PREVIOUSLY_REGISTERED: 'previouslyRegistered',
  ERROR_CEREMONY_ABORTED: null,
  REGISTRATION_CANCELLED: null,
  AUTH_CANCELLED: null,
  CHALLENGE_NOT_FOUND: 'challengeExpired',
};

export function PasskeyManager({ passkeys, onPasskeysChange }: Props) {
  const t = useTranslations('settings.account.passkeys');

  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [renameValue, setRenameValue] = useState('');
  /** A mapped refusal key, or `''` for "nothing to say". */
  const [notice, setNotice] = useState<NoticeKey>('');

  /**
   * Turn whatever the plugin handed back into a notice — or into silence.
   *
   * An unrecognised code falls back to the GENERIC message rather than surfacing
   * the raw enum: `ERROR_AUTHENTICATOR_NO_TRANSPORTS` is not a sentence, and the
   * fourteen-member error set will grow.
   */
  function report(code: string | undefined): void {
    if (code !== undefined && code in ERROR_COPY) {
      setNotice(ERROR_COPY[code] ?? '');
      return;
    }
    setNotice('generic');
  }

  async function add() {
    setRegistering(true);
    setNotice('');
    try {
      // The default NAME is read from the browser, not left blank: two rows have
      // to be tellable apart and `name` is the only field that does it, so a list
      // of unnamed credentials is the outcome of proposing nothing. The reader
      // renames it whenever they like (the modal below).
      const res = await passkey.addPasskey({ name: proposeName() });
      if (res?.error) {
        report(errorCode(res.error));
        return;
      }
      const created = res?.data;
      if (created) onPasskeysChange([...passkeys, toDTO(created)]);
    } finally {
      setRegistering(false);
    }
  }

  async function rename() {
    if (!dialog) return;
    const target = dialog.passkey;
    const name = renameValue.trim().slice(0, PASSKEY_NAME_MAX_LENGTH);
    setBusy(true);
    try {
      const res = await passkey.updatePasskey({ id: target.id, name });
      if (res?.error) {
        report(errorCode(res.error));
        return;
      }
      onPasskeysChange(passkeys.map((p) => (p.id === target.id ? { ...p, name } : p)));
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!dialog) return;
    const target = dialog.passkey;
    setBusy(true);
    try {
      const res = await passkey.deletePasskey({ id: target.id });
      if (res?.error) {
        report(errorCode(res.error));
        return;
      }
      onPasskeysChange(passkeys.filter((p) => p.id !== target.id));
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      header={
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-sans text-[15px] font-semibold text-(--el-text)">{t('title')}</h3>
            <p className="mt-1 max-w-[52ch] font-sans text-xs leading-relaxed text-(--el-text-muted)">
              {t('subtitle')}
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void add()}
            loading={registering}
            className="shrink-0"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t('add')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {notice ? (
          <Notice tone={notice === 'previouslyRegistered' ? 'info' : 'warn'}>
            {notice === 'previouslyRegistered'
              ? t('errors.previouslyRegistered')
              : notice === 'challengeExpired'
                ? t('errors.challengeExpired', { minutes: PASSKEY_CHALLENGE_TTL_MINUTES })
                : t('errors.generic')}
          </Notice>
        ) : null}

        {registering ? (
          <div className="flex items-center gap-3 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-3.5">
            <span
              className="h-[18px] w-[18px] shrink-0 animate-spin rounded-full border-2 border-(--el-border-strong) border-t-(--el-accent)"
              aria-hidden
            />
            <div className="min-w-0">
              <div className="font-sans text-sm font-medium text-(--el-text)">
                {t('registering.title')}
              </div>
              <p className="mt-0.5 font-sans text-xs leading-relaxed text-(--el-text-secondary)">
                {t('registering.body')}
              </p>
            </div>
          </div>
        ) : null}

        {passkeys.length === 0 && !registering ? (
          <div className="flex flex-col items-center gap-2.5 px-6 py-8 text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-(--el-tint-lavender) text-(--el-accent-on-surface)">
              <Fingerprint className="h-5 w-5" aria-hidden />
            </span>
            <h4 className="font-sans text-base font-semibold text-(--el-text)">
              {t('empty.title')}
            </h4>
            <p className="max-w-[46ch] font-sans text-sm leading-relaxed text-(--el-text-secondary)">
              {t('empty.body')}
            </p>
            <p className="max-w-[46ch] font-sans text-xs leading-relaxed text-(--el-text-muted)">
              {t('empty.promise')}
            </p>
          </div>
        ) : null}

        {passkeys.length > 0 ? (
          <ul className="flex flex-col">
            {passkeys.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3.5 border-b border-(--el-border-soft) py-3.5 last:border-b-0"
              >
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-mint) text-(--el-success)">
                  <Fingerprint className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
                    {/* A row with no name still has to be addressable — the
                        fallback is a LABEL, never an empty cell, and the DTO
                        keeps `name` null so an unnamed row stays
                        distinguishable from one somebody named. */}
                    <span className="truncate">{p.name ?? t('row.unnamed')}</span>
                    {p.deviceType === 'multiDevice' ? (
                      <Pill severity="info">
                        <Cloud className="h-3 w-3" aria-hidden />
                        {t('row.synced')}
                      </Pill>
                    ) : (
                      <Pill tone="neutral">{t('row.singleDevice')}</Pill>
                    )}
                  </div>
                  <p className="mt-0.5 font-sans text-xs text-(--el-text-muted)">
                    {t('row.added', { date: formatDate(p.createdAt) })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRenameValue(p.name ?? '');
                      setDialog({ kind: 'rename', passkey: p });
                    }}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                    {t('row.rename')}
                  </Button>
                  {/* ⚠️ The label is NOT danger-coloured, deliberately.
                      `--el-danger` measures 4.25:1 on the dark page, so red
                      LABEL text fails AA there; graphics need only 3:1. The hue
                      goes in the GLYPH and the label stays on `--el-text`. The
                      confirmation below carries the solid danger fill, which is
                      where that pairing is correct. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDialog({ kind: 'remove', passkey: p })}
                  >
                    <Trash2 className="h-4 w-4 text-(--el-danger)" aria-hidden />
                    {t('row.remove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Modal
        open={dialog?.kind === 'rename'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={t('rename.title')}
        description={t('rename.desc')}
      >
        <Modal.Body>
          <Input
            label={t('rename.label')}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={PASSKEY_NAME_MAX_LENGTH}
            helperText={t('rename.helper', { max: PASSKEY_NAME_MAX_LENGTH })}
            autoFocus
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {t('rename.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void rename()}>
            {t('rename.save')}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal
        open={dialog?.kind === 'remove'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={t('remove.title', { name: dialog?.passkey.name ?? t('row.unnamed') })}
        description={t('remove.desc')}
      >
        <Modal.Body>
          {/* CONDITIONAL, and only on the last one: that is the case where the
              consequence is not obvious — the reader goes back to a password. */}
          {passkeys.length === 1 ? <Notice tone="warn">{t('remove.lastWarning')}</Notice> : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {t('remove.keep')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {t('remove.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}

/**
 * The `code` off whatever the client handed back, or `undefined`.
 *
 * The error union genuinely has an arm WITHOUT a code — a plain transport
 * failure, where there is no ceremony outcome to name — and that arm should fall
 * through to the generic copy rather than being coerced into a passkey-specific
 * story about what went wrong.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * An inline notice on the card.
 *
 * A local twin of `TwoFactorManager`'s `Callout` rather than an import: that one
 * is a private helper in a component this card must not reach into, and lifting
 * it into `components/ui` is a refactor of a shipped surface that this card was
 * not asked to make. Same tokens, same shape, so the two read identically.
 */
function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const bg = tone === 'info' ? 'bg-(--el-tint-sky)' : 'bg-(--el-tint-peach)';
  const ink = tone === 'info' ? 'text-(--el-info)' : 'text-(--el-warning)';
  const Icon = tone === 'info' ? AlertTriangle : Clock;
  return (
    <div className={`flex items-start gap-2.5 rounded-(--radius-card) px-3.5 py-3 ${bg}`}>
      <Icon className={`mt-px h-[18px] w-[18px] shrink-0 ${ink}`} aria-hidden />
      <p className="font-sans text-sm leading-relaxed text-(--el-text-strong)">{children}</p>
    </div>
  );
}

/**
 * The name the register call proposes.
 *
 * Read from the browser at registration so the list is legible before anyone
 * types: "MacBook Pro", "Chrome on Windows". `userAgentData` where it exists
 * (Chromium), the platform string otherwise, and a plain fallback when neither
 * is available — this runs in a client component, but a component test renders
 * it under jsdom where `navigator.platform` is a stub.
 */
function proposeName(): string {
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string; brands?: { brand: string }[] } }
  ).userAgentData;
  const platform = uaData?.platform || navigator.platform || '';
  const brand = uaData?.brands?.find((b) => !/Not.?A.?Brand/i.test(b.brand))?.brand;
  if (brand && platform) return `${brand} on ${platform}`;
  return platform || 'Passkey';
}

/**
 * The plugin's `Passkey` (a full credential row) → the DTO the list renders.
 *
 * The credential material is DROPPED here for the same reason
 * `lib/mappers/passkeyMappers.ts` drops it server-side: this component renders
 * identity and provenance, and a shape that carried `publicKey` would put it in
 * React state for no reason. `createdAt` arrives as a `Date` over the wire-ish
 * client boundary and as a string from the server read, so it is normalised.
 */
function toDTO(row: {
  id: string;
  name?: string | undefined;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date | string;
}): PasskeyDTO {
  return {
    id: row.id,
    name: row.name ?? null,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
  };
}

/**
 * A registration date, rendered client-side only — the same explicit option set
 * `TwoFactorManager.formatDate` uses, for the same reason: the bare
 * `toLocaleDateString` is implementation-defined and a component test asserts on
 * this output.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
