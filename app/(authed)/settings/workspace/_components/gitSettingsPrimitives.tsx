import { type ReactNode } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';

// Shared presentational primitives for the git connect-settings surface (Story
// 7.23 · MOTIR-1478). Both provider variants — GitHub (7.10) and GitLab (7.23) —
// compose the SAME chrome (the card's "provider is a variant, not a separate
// look"); these are the pieces they share, lifted out of the GitHub page so the
// GitLab page reuses the exact markup rather than a parallel copy. Colour via
// `--el-*`, shape via element-semantic tokens.

/** The post-OAuth status banner (`?github=` / `?gitlab=` outcome). `role="status"`
 *  so the outcome reaches assistive tech; the hue lives in the tint BACKGROUND
 *  with strong ink (finding #35 / AA). */
export function SettingsBanner({
  tone,
  message,
}: {
  tone: 'success' | 'danger' | 'info';
  message: string;
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-(--el-tint-mint) text-(--el-text-strong)'
      : tone === 'danger'
        ? 'bg-(--el-danger-surface) text-(--el-danger-surface-text)'
        : 'bg-(--el-callout-bg) text-(--el-callout-text)';
  return (
    <div
      role="status"
      className={`rounded-(--radius-card) px-(--spacing-card-padding) py-3 font-sans text-sm ${toneClass}`}
    >
      {message}
    </div>
  );
}

/** A connect-step row (design Panel 1): an icon badge + eyebrow + title + copy,
 *  with an optional trailing affordance (e.g. an install / help link). */
export function GrantRow({
  icon,
  eyebrow,
  title,
  body,
  extra,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  body: string;
  extra?: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-card-icon-bg) text-(--el-card-icon-fg) [&_svg]:h-[18px] [&_svg]:w-[18px]"
      >
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <span className="font-sans text-[11px] font-semibold uppercase tracking-wide text-(--el-text-eyebrow)">
          {eyebrow}
        </span>
        <h4 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h4>
        <p className="font-sans text-sm text-(--el-text-secondary)">{body}</p>
        {extra}
      </div>
    </div>
  );
}

/** The bound-identity header block (design Panel 2) — a provider-agnostic avatar
 *  (a remote `avatarUrl` when the provider stores one, else an initials disc) +
 *  `@login` + a "Verified" success pill + a caption, with an optional trailing
 *  control (Disconnect). GitHub passes its identity's avatar; GitLab stores no
 *  avatar, so it falls to the initials disc. */
export function IdentityHeader({
  login,
  avatarUrl,
  verified,
  caption,
  trailing,
}: {
  login: string;
  avatarUrl?: string | null;
  verified: string;
  caption: string;
  trailing?: ReactNode;
}) {
  const initial = login.charAt(0).toUpperCase() || '?';
  return (
    <div className="flex items-center gap-3">
      {avatarUrl ? (
        // A remote provider avatar URL (the shipped AvatarField <img object-cover>
        // pattern); not a bundled asset, so next/image adds no value here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--el-avatar-fallback) font-sans text-sm font-semibold text-(--el-text-inverted)"
        >
          {initial}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-sans text-sm font-semibold text-(--el-text)">
            @{login}
          </span>
          <Pill severity="success">
            <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
            {verified}
          </Pill>
        </div>
        <span className="truncate font-sans text-xs text-(--el-text-muted)">{caption}</span>
      </div>
      {trailing}
    </div>
  );
}
