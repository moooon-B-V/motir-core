import { getTranslations } from 'next-intl/server';
import { UserMenu } from '@/app/(authed)/_components/UserMenu';
import { PublicAuthDialog } from '@/app/(public)/_components/PublicAuthDialog';
import { BuildingInPublicBadge } from '@/components/projects/BuildingInPublicBadge';
import { publicProjectPath } from '@/lib/publicProjects/urls';

// The public top bar (Story 6.12 · Subtask 6.12.4 · design Panel 2 `.pub-topbar`).
// Logo tile + project name + the "Building in public" status badge +
// key/workspace, and — on the right — the auth-aware slot: a signed-in visitor
// sees their account menu (design Panel 1b), a logged-out visitor sees the
// Sign in / Start free CTAs. Server component; colour via --el-* tokens.
//
// The logged-out CTAs now open the in-place sign-in / sign-up MODAL
// (`PublicAuthDialog`, MOTIR-1558) instead of navigating to /sign-in · /sign-up —
// the visitor authenticates without leaving this public page. The modal's
// email/Google callbackURL is THIS public path, so OAuth returns the visitor to
// the same page (MOTIR-990 #2/#3/#4). A client child rendered by this server
// component — fine (the CTAs + Radix dialog are the only client bit).
//
// Story 6.17.4 reframes the old "Public" globe Pill to the build-in-public
// status badge (megaphone + "Building in public", design Panels 1–2) — the same
// badge shown in the authed settings access row, so the status reads identically
// to visitors and the team.

export async function PublicTopBar({
  name,
  identifier,
  workspaceName,
  user,
}: {
  name: string;
  identifier: string;
  workspaceName: string;
  user: { name: string; email: string } | null;
}) {
  const t = await getTranslations('publicProjects');
  const initial = name.trim().charAt(0).toUpperCase() || 'P';
  return (
    <div className="flex items-center justify-between gap-4 border-b border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-sm font-extrabold text-(--el-accent-text)"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-bold text-(--el-text)">{name}</span>
            <BuildingInPublicBadge label={t('buildingInPublicChip')} />
          </div>
          <span className="font-mono text-xs text-(--el-text-faint)">
            {identifier} · {workspaceName}
          </span>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        {user ? (
          <UserMenu name={user.name} email={user.email} />
        ) : (
          <PublicAuthDialog callbackPath={publicProjectPath(identifier)} />
        )}
      </div>
    </div>
  );
}
