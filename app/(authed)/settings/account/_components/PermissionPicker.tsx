'use client';

import { useTranslations } from 'next-intl';
import { Switch } from '@/components/ui/Switch';
import {
  permissionSlug,
  type PermissionDomain,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { permissionColumnsForTokens, type PermissionMeta } from './permissionMeta';

// The token-permission PICKER (Story MOTIR-2572 · MOTIR-2580, design
// `design/settings/permission-columns.mock.html`) — the two columns of catalog
// domain groups, one Switch per grantable permission, the irreversible key in
// its own rose danger card. Lifted out of `CreateTokenModal` for the OAuth
// consent screen (MOTIR-6985), so the two surfaces that ask a person "what may
// this do?" mount ONE component and cannot drift on what a permission is called
// or which rows a person may switch on.
//
// It owns no state: the caller holds the granted set and the offer. A row the
// person cannot confer here is DISABLED with its reason, never hidden
// (MOTIR-2578 panel 1c) — a vanished row reads as a missing feature, a disabled
// one teaches the rule.
//
// ⚠️ The "· Danger" tag is `--el-danger-on-surface`, not raw `--el-danger`:
// raw danger is under AA on the dark page in three palettes and on most tints,
// and the rose card is a tint (CLAUDE.md, the danger rule;
// `design/auth/design-notes.md` § OAuth consent, "The one deliberate delta").

export interface PermissionPickerProps {
  /** The id of the element naming the group ("Permissions", "What it can do"). */
  labelledBy: string;
  /** What the person may confer here; every other row renders locked. */
  conferrable: ReadonlySet<PermissionKey>;
  /** The switched-on keys. */
  granted: ReadonlySet<PermissionKey>;
  onToggle: (key: PermissionKey) => void;
  /** The locked row's reason line. */
  lockedWhy: string;
  /** The irreversible key's tag, e.g. "· Danger". */
  dangerTag: string;
  disabled?: boolean;
}

export function PermissionPicker({
  labelledBy,
  conferrable,
  granted,
  onToggle,
  lockedWhy,
  dangerTag,
  disabled = false,
}: PermissionPickerProps) {
  // The permission LABELS + DESCRIPTIONS are the shipped catalogue copy, so the
  // picker, the list row, /device and the consent screen say the same words.
  const tp = useTranslations('permissions');
  // The domain groups, split so each column carries half the ROWS — MOTIR-2578's
  // measured composition. Balancing by group COUNT would make it taller.
  const [leftColumn, rightColumn] = permissionColumnsForTokens();

  // One permission row — icon + name + one-line description, its Switch on the
  // right. The delete key renders as its OWN rose danger card (7.7.18), so
  // granting irreversible deletion is a deliberate, visible act. Render helpers,
  // not nested components, so they close over the props without remounting.
  function renderRow(meta: PermissionMeta) {
    const locked = !conferrable.has(meta.key);
    const checked = granted.has(meta.key) && !locked;
    // ⚠️ The SHIPPED catalogue copy — the strings Roles & permissions renders.
    const name = tp(`${permissionSlug(meta.key)}.label`);
    const desc = tp(`${permissionSlug(meta.key)}.description`);
    const Icon = meta.Icon;
    if (meta.danger) {
      return (
        <div
          key={meta.key}
          className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y)"
        >
          <div className="flex items-start gap-2.5">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--el-danger)" />
            <div className="min-w-0 flex-1">
              <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                {name}{' '}
                <span className="font-mono text-[0.625rem] tracking-wide text-(--el-danger-on-surface) uppercase">
                  {dangerTag}
                </span>
              </span>
              <p className="mt-0.5 font-sans text-xs text-(--el-text-strong)">{desc}</p>
            </div>
            <Switch
              checked={checked}
              disabled={locked || disabled}
              onCheckedChange={() => onToggle(meta.key)}
              aria-label={name}
            />
          </div>
          {locked ? (
            <p className="mt-1 font-sans text-xs text-(--el-text-strong)">{lockedWhy}</p>
          ) : null}
        </div>
      );
    }
    return (
      <div key={meta.key} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--el-text-muted)" />
        <div className="min-w-0 flex-1">
          <span
            aria-disabled={locked || undefined}
            className={`font-sans text-sm font-medium ${locked ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
          >
            {name}
          </span>
          <p
            aria-disabled={locked || undefined}
            className={`mt-0.5 font-sans text-xs ${locked ? 'text-(--el-text-faint)' : 'text-(--el-text-muted)'}`}
          >
            {desc}
          </p>
          {locked ? (
            <p className="mt-0.5 font-sans text-xs text-(--el-text-secondary)">{lockedWhy}</p>
          ) : null}
        </div>
        <Switch
          checked={checked}
          disabled={locked || disabled}
          onCheckedChange={() => onToggle(meta.key)}
          aria-label={name}
        />
      </div>
    );
  }

  // One capability group — a mono/uppercase caption over its hairline-separated
  // safe rows, then any danger card below.
  function renderGroup(domain: PermissionDomain, metas: PermissionMeta[]) {
    const safe = metas.filter((m) => !m.danger);
    const danger = metas.filter((m) => m.danger);
    return (
      // ⚠️ AA: the domain heading is INFORMATIONAL, so `--el-text-secondary`,
      // never `--el-text-faint` — the correction MOTIR-2578 made in the asset.
      <div key={domain} className="flex flex-col gap-2">
        <div className="font-mono text-[0.625rem] tracking-wide text-(--el-text-secondary) uppercase">
          {tp(`domain.${domain}`)}
        </div>
        {safe.length > 0 ? (
          <div className="divide-y divide-(--el-border-soft)">{safe.map(renderRow)}</div>
        ) : null}
        {danger.map(renderRow)}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="mt-1 grid gap-x-6 gap-y-4 sm:grid-cols-2"
    >
      {/* Two columns, split so neither drives the height alone. The GROUPS are
          the catalog's domains, derived, so a permission added to the grantable
          set lands in a column without an edit here. */}
      <div className="flex flex-col gap-4">
        {leftColumn.map((g) => renderGroup(g.domain, g.permissions))}
      </div>
      <div className="flex flex-col gap-4">
        {rightColumn.map((g) => renderGroup(g.domain, g.permissions))}
      </div>
    </div>
  );
}
