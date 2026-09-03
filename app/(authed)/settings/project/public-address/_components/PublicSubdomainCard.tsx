'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';

/**
 * THE WORKSPACE SUBDOMAIN CARD (Story MOTIR-3878 · MOTIR-4221) — design panels
 * 1 (unclaimed, with both refusals), 2 (claimed, the alias, the rename confirm)
 * and 8 (read-only).
 *
 * ── ⚠️ ONE FIELD, TWO ACTS, BECAUSE THE ROUTE IS ONE VERB ─────────────────
 *
 * `PUT /api/workspaces/{id}/public-subdomain` CLAIMS when the workspace has no
 * subdomain and RENAMES when it has one — the route's own note explains that
 * from the customer's side there is one control and which act it performs is a
 * fact about the server's state. So this component has one submit path and two
 * presentations, rather than two paths that could disagree about the payload.
 *
 * ── ⚠️ THE REFUSALS ARE MAPPED FROM CODES, NEVER FROM MESSAGES ────────────
 *
 * The service's errors carry a `code`, and `RESERVED_LABEL` additionally carries
 * a `refusal` DISCRIMINATOR — `reserved` and `bad_grammar` send a customer to
 * completely different next actions, which is exactly why MOTIR-4215 put it on
 * the wire rather than folding both into one sentence. Rendering the server's
 * English `error` string would throw the zh catalogue away and couple the pane
 * to prose; this maps the code and lets the catalogue speak.
 */

/** The refusal discriminator on `RESERVED_LABEL`, mapped to its copy key. */
const REFUSAL_KEY: Record<string, string> = {
  reserved: 'reserved',
  structurally_reserved: 'structurallyReserved',
  too_short: 'tooShort',
  too_long: 'tooLong',
  bad_grammar: 'badGrammar',
};

interface Refusal {
  readonly code?: string;
  readonly refusal?: string;
}

export function PublicSubdomainCard({
  workspaceId,
  baseDomain,
  projectIdentifier,
  subdomain,
  canManage,
}: {
  workspaceId: string;
  /** `motir.site` — the suffix the field shows and the preview is built from. */
  baseDomain: string;
  /** Only ever used to draw the live preview's example path. */
  projectIdentifier: string;
  subdomain: PublicSubdomainDto | null;
  /**
   * The WORKSPACE role's answer, not the project permission the rail row is
   * gated on — see the page's note. `false` renders panel 8: every address
   * visible, every control ABSENT rather than disabled.
   */
  canManage: boolean;
}) {
  const t = useTranslations('settings.publicAddress');
  const { toast } = useToast();
  const router = useRouter();

  const [label, setLabel] = useState(subdomain?.label ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const preview = `${label || 'acme'}.${baseDomain}/${projectIdentifier}`;

  async function submit(next: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/public-subdomain`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Refusal;
        setError(messageFor(body));
        return;
      }
      setRenaming(false);
      toast({ variant: 'success', title: t('subdomain.title') });
      // ⚠️ REFRESH RATHER THAN PATCH LOCAL STATE. A claim produces a DTO whose
      // aliases and `renamesLeft` are derived server-side (the alias rows ARE
      // the count), so re-reading is the only way the pane and the store agree.
      // Optimism here would mean re-deriving the cap in the browser.
      router.refresh();
    } catch {
      setError(t('error.generic'));
    } finally {
      setSaving(false);
    }
  }

  function messageFor(body: Refusal): string {
    if (body.code === 'RESERVED_LABEL') {
      const key = REFUSAL_KEY[body.refusal ?? ''];
      return key ? t(`error.${key}`, { label }) : t('error.generic');
    }
    if (body.code === 'HOSTNAME_TAKEN') return t('error.taken', { label });
    if (body.code === 'SUBDOMAIN_RENAME_CAP_REACHED') return t('error.capReached');
    if (body.code === 'SUBDOMAIN_FORBIDDEN') return t('error.forbidden');
    return t('error.generic');
  }

  return (
    <Card className="flex flex-col gap-4 p-(--spacing-card-padding)">
      <header className="flex flex-col gap-1">
        <h2 className="font-sans text-[15px] font-semibold text-(--el-text)">
          {t('subdomain.title')}
        </h2>
        <p className="font-sans text-[13px] text-(--el-text-secondary)">
          {canManage ? t('subdomain.subtitle') : t('subdomain.readOnly')}
        </p>
      </header>

      {subdomain ? (
        <ClaimedRows
          subdomain={subdomain}
          projectIdentifier={projectIdentifier}
          canManage={canManage}
          onRename={() => {
            setLabel(subdomain.label);
            setError(null);
            setRenaming(true);
          }}
        />
      ) : canManage ? (
        <div className="flex flex-col gap-4">
          <Input
            label={t('subdomain.label')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            addonEnd={
              <span className="font-mono text-[13px] text-(--el-text-secondary)">
                .{baseDomain}
              </span>
            }
            helperText={t('subdomain.helper', { preview })}
            error={error ?? undefined}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="md"
              loading={saving}
              disabled={label.trim() === ''}
              onClick={() => void submit(label.trim())}
            >
              {t('subdomain.claim')}
            </Button>
            <span className="font-sans text-[12px] text-(--el-text-secondary)">
              {t('subdomain.claimable')}
            </span>
          </div>
        </div>
      ) : (
        <p className="font-sans text-[13px] text-(--el-text-secondary)">{t('subdomain.none')}</p>
      )}

      {/* The rename confirm — panel 2's right stage. It carries the ADR §8
          decision in the customer's words, and the remaining count, because a
          cap the customer cannot see is a cap they meet as a refusal. */}
      <Modal
        open={renaming}
        onOpenChange={(open) => {
          setRenaming(open);
          if (!open) setError(null);
        }}
        title={t('rename.title')}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={t('subdomain.label')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            addonEnd={
              <span className="font-mono text-[13px] text-(--el-text-secondary)">
                .{baseDomain}
              </span>
            }
            error={error ?? undefined}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex flex-col gap-1.5 rounded-(--radius-control) bg-(--el-tint-yellow) px-4 py-3">
            <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
              {t('rename.warningTitle')}
            </span>
            <span className="font-sans text-[13px] leading-[1.6] text-(--el-text-strong)">
              {t('rename.warningBody', { old: subdomain?.hostname ?? '' })}{' '}
              {t('rename.remaining', { count: Math.max((subdomain?.renamesLeft ?? 1) - 1, 0) })}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="md" onClick={() => setRenaming(false)}>
              {t('rename.cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={saving}
              disabled={label.trim() === '' || label.trim() === subdomain?.label}
              onClick={() => void submit(label.trim())}
            >
              {t('rename.confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/** Panel 2's left stage, and panel 8's whole body — the addresses as rows. */
function ClaimedRows({
  subdomain,
  projectIdentifier,
  canManage,
  onRename,
}: {
  subdomain: PublicSubdomainDto;
  projectIdentifier: string;
  canManage: boolean;
  onRename: () => void;
}) {
  const t = useTranslations('settings.publicAddress');
  const { toast } = useToast();
  const live = `${subdomain.hostname}/${projectIdentifier}`;

  return (
    <div className="flex flex-col gap-2">
      <AddressRow
        host={live}
        pill={<Pill severity="success">{t('subdomain.active')}</Pill>}
        actions={
          <>
            <CopyButton
              value={`https://${live}`}
              label={t('subdomain.copy')}
              onCopied={() => toast({ variant: 'success', title: t('subdomain.copied') })}
            />
            <a
              href={subdomain.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t('subdomain.open')}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          </>
        }
      />

      {/* ⚠️ EVERY RETIRED LABEL IS DRAWN, not summarised as a count. ADR §8's
          promise is that each one keeps redirecting for ever, and a customer
          deciding whether to rename again is deciding about these exact
          hostnames. */}
      {subdomain.aliases.map((alias) => (
        <AddressRow
          key={alias.hostname}
          host={alias.hostname}
          pill={<Pill status="planned">{t('subdomain.alias')}</Pill>}
        />
      ))}

      {canManage ? (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-sans text-[13px] text-(--el-text-secondary)">
            {t('subdomain.renamesLeft', { count: subdomain.renamesLeft })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRename}
            disabled={subdomain.renamesLeft === 0}
          >
            {t('subdomain.rename')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AddressRow({
  host,
  pill,
  actions,
}: {
  host: string;
  pill: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-(--height-control) items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">{host}</span>
      {pill}
      {actions}
    </div>
  );
}

function CopyButton({
  value,
  label,
  onCopied,
}: {
  value: string;
  label: string;
  onCopied: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(onCopied);
      }}
      className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
    >
      <Copy className="h-4 w-4" aria-hidden />
    </button>
  );
}
