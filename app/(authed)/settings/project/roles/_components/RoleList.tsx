import Link from 'next/link';
import { ChevronRight, Info, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { RoleCatalogDTO, RoleDTO } from '@/lib/dto/permissions';
import { PermissionMark } from './PermissionMark';
import { RoleGlyph, roleDescription, roleName, roleTileTint } from './roleIdentity';

// The role LIST — screen 1 of the Roles & permissions drill-down (Subtask
// MOTIR-2263), built to `design/projects/roles-permissions.mock.html` panel 0.
//
// ⚠️ A LIST, NOT A MATRIX, AND THAT IS THE WHOLE POINT. An earlier revision put
// permissions on rows and roles on columns; it read well at three roles and, as
// the design notes measured, "could not survive five" — and custom roles
// (MOTIR-2257) are exactly what makes five happen. A structure whose width is
// consumed by the thing the feature adds is the wrong structure, so each role is
// a ROW you drill into and the comparison the matrix gave is carried by the
// `N of M` on every row.
//
// ⚠️ THE INKS HERE ARE AA-DRIVEN, AND THE ASSET NOW AGREES (MOTIR-2455). The
// mock's first revision put the `Built-in` chip and the member count in
// `--el-text-faint` on `--el-surface`; axe measured 2.39:1 against AA's 4.5:1,
// and `--el-text-muted` on that same off-white is 4.17:1 — also under. The asset
// has been corrected to match what is here, so this is no longer a divergence:
// active informational text takes `--el-text-secondary` (AA on every surface in
// both themes) and the containers take `--el-card`, the white the shipped `Card`
// primitive paints. `--el-text-faint` survives ONLY on the chevron and the
// permission marks, which are glyphs whose meaning is carried by an `aria-label`.
// The measured table lives in `motir-core/CLAUDE.md` and in the token's own
// comment in `packages/design-system/theme.css`.
//
// ⚠️ EVERY NUMBER COMES FROM THE READ. `N` is the role's own set length, `M` is
// `roleGatedPermissionCount`, and the headcount is `memberCount` — all three off
// `getRoleCatalog` (MOTIR-2439). Nothing here imports the catalog or counts a
// constant, so the day a custom role narrows the answer per project this
// component is already right.

export function RoleList({ catalog }: { catalog: RoleCatalogDTO }) {
  const t = useTranslations('settings.rolesPage');

  return (
    <div className="flex flex-col gap-5">
      <div className="border-(--el-border) bg-(--el-surface-soft) text-(--el-text-secondary) flex items-start gap-2 rounded-(--radius-card) border px-(--spacing-card-padding) py-(--spacing-control-y) font-sans text-[12.5px] leading-relaxed">
        <Info aria-hidden="true" className="mt-[2px] h-4 w-4 shrink-0 text-(--el-text-faint)" />
        <span>{t('builtInNote')}</span>
      </div>

      <ul className="border-(--el-border) bg-(--el-card) list-none overflow-hidden rounded-(--radius-card) border shadow-(--shadow-card)">
        {catalog.roles.map((role) => (
          <li key={role.key} className="border-(--el-border-soft) border-b last:border-b-0">
            <RoleRow role={role} total={catalog.roleGatedPermissionCount} />
          </li>
        ))}
      </ul>

      <LevelGatedCard domains={catalog.levelGatedDomains} />
    </div>
  );
}

/**
 * One role row. The whole row is a LINK — a real control, focusable and
 * activatable by keyboard, rather than a click handler on a div.
 */
function RoleRow({ role, total }: { role: RoleDTO; total: number }) {
  const t = useTranslations('settings.rolesPage');
  const tRoles = useTranslations();

  return (
    <Link
      href={`/settings/project/roles/${role.key}`}
      data-role-row={role.key}
      className="hover:bg-(--el-surface-soft) focus-visible:ring-(--focus-ring-color) grid grid-cols-[36px_minmax(0,1fr)_auto_16px] items-center gap-3.5 px-(--spacing-card-padding) py-(--spacing-control-y) focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className={`${roleTileTint(role)} flex h-9 w-9 items-center justify-center rounded-(--radius-control)`}
      >
        <RoleGlyph role={role} className="h-[17px] w-[17px]" />
      </span>

      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-(--el-text) font-sans text-sm font-semibold">
            {roleName(role, tRoles)}
          </span>
          {role.builtIn ? (
            <span className="text-(--el-text-secondary) inline-flex items-center gap-1 font-sans text-[11px] font-medium whitespace-nowrap">
              <Lock aria-hidden="true" className="h-3 w-3" />
              {t('builtIn')}
            </span>
          ) : (
            /* The `Custom` chip — `--el-tint-sky`, the slot the design pairs with
               a custom role (`severity="info"` is that token; `tone` has no sky).
               The kind is in WORDS, so the tint is never load-bearing. */
            <Pill severity="info" className="shrink-0">
              {t('custom')}
            </Pill>
          )}
        </span>
        {/* BOTH sides of the merge: MOTIR-2477 swept this ink off the tinted
            row (`--el-text-muted` -> `--el-text-secondary`), and MOTIR-2478
            widened the DTO so a CUSTOM role's description is a literal rather
            than an i18n key. Taking either alone regresses the other. */}
        <span className="text-(--el-text-secondary) mt-0.5 block font-sans text-[12.5px] leading-relaxed">
          {roleDescription(role, tRoles)}
        </span>
      </span>

      <span className="flex flex-col items-end gap-0.5 text-right whitespace-nowrap">
        <span className="text-(--el-text-secondary) font-mono text-xs">
          {t('permissionCount', { held: role.permissions.length, total })}
        </span>
        <span className="text-(--el-text-secondary) font-sans text-[11.5px]">
          {t('memberCount', { count: role.memberCount })}
        </span>
      </span>

      <ChevronRight aria-hidden="true" className="text-(--el-text-faint) h-4 w-4" />
    </Link>
  );
}

/**
 * The permissions the project's ACCESS LEVEL decides rather than any role — kept
 * OUT of the list above and explained here.
 *
 * ⚠️ IT IS NOT DECORATION. A reader who knows Motir governs public requests and
 * cannot find them under any role would reasonably conclude this page describes
 * less than the whole model. The rows come from `levelGatedDomains`, the exact
 * complement of the role rows over the catalog (MOTIR-2439), so the two together
 * are always everything.
 */
function LevelGatedCard({ domains }: { domains: RoleCatalogDTO['levelGatedDomains'] }) {
  const t = useTranslations('settings.rolesPage');
  const tCatalog = useTranslations();
  if (domains.length === 0) return null;
  const permissions = domains.flatMap((group) => group.permissions);

  return (
    <Card
      header={
        <div className="border-(--el-border-soft) flex items-start justify-between gap-3 border-b pb-2.5">
          <div className="min-w-0">
            <h2 className="text-(--el-text) font-sans text-sm font-semibold">
              {t('levelGated.title')}
            </h2>
            <p className="text-(--el-text-muted) mt-1 font-sans text-[12.5px] leading-relaxed">
              {t('levelGated.description')}
            </p>
          </div>
          <Pill tone="neutral" className="shrink-0">
            <Info aria-hidden="true" className="h-3 w-3" />
            {t('levelGated.chip')}
          </Pill>
        </div>
      }
    >
      <ul className="list-none">
        {permissions.map((permission) => (
          <li
            key={permission.key}
            data-permission={permission.key}
            className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2 pt-[7px]"
          >
            <PermissionMark kind="level" label={t('mark.levelGranted')} />
            <span className="min-w-0">
              <span className="text-(--el-text) font-sans text-[13px] font-medium">
                {tCatalog(permission.labelKey)}
              </span>{' '}
              <span className="text-(--el-text-muted) font-sans text-xs">
                {tCatalog(permission.descriptionKey)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
