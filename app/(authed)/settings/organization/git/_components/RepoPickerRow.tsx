'use client';

import { useTranslations } from 'next-intl';
import { Check, CircleAlert, Lock } from 'lucide-react';
import { Checkbox } from '@/components/ui/Checkbox';

// ONE ROW OF THE REPO PICKER (Story MOTIR-8216 · MOTIR-8223), built to
// `design/github/github--multi-org-account.mock.html` Panels A3a and A5.
//
// ⚠️ THREE KINDS, AND THE LOCKED ONE NAMES NOBODY. `connected_elsewhere` says
// `Connected to another organisation` and nothing else — no organisation, no
// project, no count, no tooltip. The response it is drawn from carries no such
// identifier (MOTIR-8220), and this row could not leak one if it tried; the
// test asserts the DOM anyway, because the sentence is the contract.
//
// `connected_here` is checked AND locked. The picker only ADDS: removing a
// repository already has a home that names the projects it affects — the
// inventory row's Disconnect — so a second, less honest removal is not offered.

export type RepoAvailability = 'available' | 'connected_here' | 'connected_elsewhere';

export interface RepoPickerRowProps {
  fullName: string;
  availability: RepoAvailability;
  checked: boolean;
  onToggle: (next: boolean) => void;
  /** The 409 refusal's sentence, when this row was just taken by another organisation. */
  error?: string | null;
}

export function RepoPickerRow({
  fullName,
  availability,
  checked,
  onToggle,
  error,
}: RepoPickerRowProps) {
  const t = useTranslations('github.picker');
  const slash = fullName.indexOf('/');
  const owner = slash >= 0 ? fullName.slice(0, slash + 1) : '';
  const name = slash >= 0 ? fullName.slice(slash + 1) : fullName;
  const locked = availability !== 'available';

  return (
    <li className="flex flex-col">
      <div
        data-availability={availability}
        aria-disabled={locked || undefined}
        className="flex min-h-(--height-control) items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-option-active-bg)"
      >
        <Checkbox
          checked={availability === 'connected_here' ? true : checked}
          onChange={onToggle}
          disabled={locked}
          label={fullName}
          stateLabels={{ checked: t('rowState.selected'), unchecked: t('rowState.notSelected') }}
        />
        <span className="min-w-0 flex-1 truncate font-sans text-sm">
          <span className="text-(--el-text-secondary)">{owner}</span>
          <span className={locked ? 'text-(--el-text-secondary)' : 'text-(--el-text)'}>{name}</span>
        </span>
        {availability === 'connected_elsewhere' ? (
          <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
            <Lock className="h-3.5 w-3.5 text-(--el-icon-muted)" aria-hidden />
            {t('connectedElsewhere')}
          </span>
        ) : availability === 'connected_here' ? (
          <span className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
            <Check className="h-3.5 w-3.5 text-(--el-icon-muted)" aria-hidden />
            {t('connectedHere')}
          </span>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 px-(--spacing-control-x) pb-1 font-sans text-xs text-(--el-danger-on-surface)"
        >
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
    </li>
  );
}
