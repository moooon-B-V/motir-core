import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Megaphone, Settings } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * BuildingInPublicHeaderLink (Story 6.17 · Subtask 6.17.7 · design
 * design/public-projects §6.17.6 · Panel 12) — the PUBLIC state of the
 * project-shell header's single build-in-public slot.
 *
 * It fills the SAME header slot the {@link BuildInPublicButton} "Build in
 * public" CTA occupies when the project is NOT public — the slot shows exactly
 * ONE of them, never both, never empty (the bug 6.17.6 fixes: the slot used to
 * go empty once `accessLevel === 'public'`). The layout resolves which one to
 * render server-side, so this component just renders the indicator.
 *
 * It reuses the {@link BuildingInPublicBadge} visual recipe VERBATIM — the
 * `pill-building` chip: a lavender `--el-build-bg` tint, AA-safe
 * `--el-build-text` label, accent `--el-build-glyph` megaphone, `--radius-badge`
 * shape — so the team reads "this project is building in public RIGHT NOW"
 * first (status primacy), the same chip they see in Settings and the public
 * visitor chrome. It is then made into a LINK (the anchor IS the chip,
 * mirroring the mock's `a.pill-building`) to the build-in-public manage/stop
 * home at `/settings/project/members`, with a secondary manage affordance: a
 * trailing muted settings gear (signalling the click goes to SETTINGS, not the
 * public page), a pointer cursor, a hover bg-shift toward the accent (mirrors
 * `.btn-build:hover`), and the app focus-ring on focus-visible.
 *
 * VISIBILITY (design §6.17.6c): shown to ALL team members while the project is
 * public — a pure server-side `accessLevel === 'public'` check, no `canManage`
 * read (unlike the non-public CTA, which is admin-gated). The destination is
 * itself role-aware (`ProjectMembersSettings` shows non-admins the badge +
 * "View public page" read-only and gates only "Stop" behind `assertCanManage`),
 * so the header link never lands anyone on a permission wall — the GitHub /
 * Linear / Notion model: status visible to the team, control gated at the
 * destination.
 *
 * A plain server-rendered `<a>` (no client state), so a `router.refresh()`
 * after going public / stopping swaps the slot's state with no hard reload
 * (page-state-after-mutation surface kind 2 — the slot is server-rendered).
 */
export function BuildingInPublicHeaderLink() {
  const t = useTranslations('settings.buildInPublic');
  return (
    <Link
      href="/settings/project/members"
      aria-label={t('manageAriaLabel')}
      className={cn(
        // The BuildingInPublicBadge `pill-building` visual recipe, on the anchor.
        'inline-flex items-center gap-1 rounded-(--radius-badge) border border-transparent',
        'px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium',
        'bg-(--el-build-bg) text-(--el-build-text) no-underline',
        // The secondary manage affordances (design §6.17.6b).
        'cursor-pointer transition-colors',
        'hover:bg-[color-mix(in_srgb,var(--el-accent)_16%,var(--el-build-bg))]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2',
      )}
    >
      <Megaphone className="size-3 text-(--el-build-glyph)" aria-hidden />
      {t('statusBadge')}
      <Settings className="size-3 text-(--el-build-text) opacity-55" aria-hidden />
    </Link>
  );
}
