import Link from 'next/link';
import { ArrowLeft, GitBranch, Lock, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type { RoleCatalogDTO, RoleDTO } from '@/lib/dto/permissions';
import { PermissionGroups } from './PermissionGroups';
import { RoleGlyph, roleDescription, roleName, roleTileTint } from './roleIdentity';

// The role DETAIL — screen 2 of the drill-down (Subtask MOTIR-2263), built to
// `design/projects/roles-permissions.mock.html` panel 1: one role's permissions
// at FULL WIDTH, under their domain headings, each description on one line.
//
// ⚠️ BOTH THE CRUMB AND THE BACK LINK, DELIBERATELY. The design notes: "the
// inherited crumb trail is orientation, the back link is the control, and a
// drill-down needs a control rather than a place to read where you are." The
// settings AREA otherwise drops per-page crumbs (the rail owns orientation) —
// this screen is the one place that sits a level BELOW a rail row, which is
// exactly the case that rule never contemplated.
//
// ⚠️ A BUILT-IN ROLE GETS A LOCK AND NO CONTROL AT ALL. Not a disabled Edit, not
// a greyed Delete: the three built-ins reproduce the shipped behaviour by
// definition, so editing one is not a thing that exists.
//
// ⚠️ STILL READ-ONLY FOR EVERY ACTOR, A PROJECT ADMIN INCLUDED (MOTIR-2478). A
// custom role now RENDERS here — with its `Custom` chip and its `Based on … · ±N`
// provenance — but this card adds no control. `Edit`, `Delete` and the
// delete-with-reassign dialog are MOTIR-2480's, drawn in panels 2 and 5 of
// `design/projects/roles-permissions.mock.html`.
//
// ⚠️ THE PROVENANCE CHIP IS WHERE THE SIDE-BY-SIDE COMPARISON WENT. The design
// gave up a matrix's four-columns-at-once and bought back something exact:
// "Contractor is Viewer plus two". `basedOnDelta` is computed in the mapper, so
// nothing here does arithmetic over a role set.

export function RoleDetail({
  role,
  catalog,
  projectName,
}: {
  role: RoleDTO;
  catalog: RoleCatalogDTO;
  projectName: string;
}) {
  const t = useTranslations('settings.rolesPage');
  const tCatalog = useTranslations();
  const displayName = roleName(role, tCatalog);

  return (
    <div className="flex flex-col">
      <p className="text-(--el-text-secondary) mb-2 font-mono text-[11px] tracking-[0.02em]">
        {t('crumbs', { projectName, roleName: displayName })}
      </p>

      <Link
        href="/settings/project/roles"
        className="text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) mb-3 inline-flex w-fit items-center gap-1.5 rounded-(--radius-control) font-sans text-[12.5px] font-medium focus-visible:ring-2"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t('allRoles')}
      </Link>

      <div className="border-(--el-border) mb-1 flex items-start justify-between gap-4 border-b pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={`${roleTileTint(role)} flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control)`}
          >
            <RoleGlyph role={role} className="h-[17px] w-[17px]" />
          </span>
          <div className="min-w-0">
            <h1 className="text-(--el-text) font-serif text-xl font-semibold">{displayName}</h1>
            <p className="text-(--el-text-muted) mt-1.5 max-w-[62ch] font-sans text-[13px] leading-relaxed">
              {roleDescription(role, tCatalog)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {role.builtIn ? (
                <span className="text-(--el-text-secondary) inline-flex items-center gap-1 font-sans text-[11px] font-medium whitespace-nowrap">
                  <Lock aria-hidden="true" className="h-3 w-3" />
                  {t('builtInLocked')}
                </span>
              ) : (
                <Pill severity="info" className="shrink-0">
                  {t('custom')}
                </Pill>
              )}
              {role.basedOn ? (
                <span className="bg-(--el-muted) text-(--el-text-secondary) inline-flex h-5 items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) font-sans text-[11.5px] whitespace-nowrap">
                  <GitBranch aria-hidden="true" className="h-3 w-3" />
                  {t('basedOn', {
                    base: tCatalog(`settings.roles.${role.basedOn}.name`),
                    delta: formatDelta(role.basedOnDelta ?? 0),
                  })}
                </span>
              ) : null}
              <span className="bg-(--el-muted) text-(--el-text-secondary) inline-flex h-5 items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) font-sans text-[11.5px] whitespace-nowrap">
                <Users aria-hidden="true" className="h-3 w-3" />
                {t('memberCount', { count: role.memberCount })}
              </span>
            </div>
          </div>
        </div>
        <p className="text-(--el-text-secondary) shrink-0 font-sans text-[12.5px] whitespace-nowrap">
          {t.rich('holdsCount', {
            held: role.permissions.length,
            total: catalog.roleGatedPermissionCount,
            strong: (chunks) => <strong className="text-(--el-text)">{chunks}</strong>,
          })}
        </p>
      </div>

      <div className="border-(--el-border) bg-(--el-card) mt-5 overflow-hidden rounded-(--radius-card) border shadow-(--shadow-card)">
        <PermissionGroups domains={catalog.domains} held={role.permissions} />
      </div>
    </div>
  );
}

/**
 * The provenance chip's `±N`, signed and with a MINUS SIGN rather than a hyphen
 * — `Based on Member · −2` is the design's exact string. `0` renders as `±0`,
 * which is the honest reading of a role that holds precisely its base's set.
 */
function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `\u2212${Math.abs(delta)}`;
  return '\u00b10';
}
