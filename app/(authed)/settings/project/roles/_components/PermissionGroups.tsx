import { useTranslations } from 'next-intl';
import type { PermissionDomainDTO } from '@/lib/dto/permissions';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { PermissionMark, type PermissionMarkKind } from './PermissionMark';

// The permission LIST the role detail renders at full width (Subtask
// MOTIR-2263) — domain headings interleaved with one row per permission, each a
// human label with its description beside it, built to
// `design/projects/roles-permissions.mock.html` panel 1.
//
// ⚠️ THE ROWS COME FROM THE READ, NEVER FROM THE CATALOG. `domains` is
// `RoleCatalogDTO.domains` (the role-gated groups `getRoleCatalog` returns) and
// `held` is that role's own set. This component imports no catalog constant and
// counts nothing itself, so the day MOTIR-2257 makes the answer project-scoped
// there is nothing here to change.
//
// ⚠️ NO ROW RENDERS A RAW CATALOG KEY. Every label and description is an i18n
// lookup; a missing string throws rather than painting `permissions.work_item:edit`
// onto a customer's settings page (next-intl's default for a missing key in a
// non-production environment, which is what the tests run in).

export function PermissionGroups({
  domains,
  held,
  markFor,
}: {
  domains: PermissionDomainDTO[];
  /** The keys this role holds. Ignored when `markFor` is supplied. */
  held?: readonly PermissionKey[];
  /** Overrides the per-row mark — the level-gated card marks every row `level`. */
  markFor?: (key: PermissionKey) => PermissionMarkKind;
}) {
  const t = useTranslations();
  const tRoles = useTranslations('settings.rolesPage');
  const holds = new Set<PermissionKey>(held ?? []);
  const kindOf = markFor ?? ((key: PermissionKey) => (holds.has(key) ? 'held' : 'withheld'));
  const markLabel: Record<PermissionMarkKind, string> = {
    held: tRoles('mark.held'),
    withheld: tRoles('mark.notHeld'),
    level: tRoles('mark.levelGranted'),
  };

  return (
    <>
      {domains.map((group) => (
        <div key={group.domain}>
          <div className="border-(--el-border-soft) bg-(--el-muted) text-(--el-text-faint) border-b px-(--spacing-card-padding) py-(--spacing-control-y) font-sans text-[11px] font-semibold tracking-[0.06em] uppercase">
            {t(group.labelKey)}
          </div>
          <ul className="list-none">
            {group.permissions.map((permission) => {
              const kind = kindOf(permission.key);
              return (
                <li
                  key={permission.key}
                  data-permission={permission.key}
                  className="border-(--el-border-soft) grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-3 border-b px-(--spacing-card-padding) py-(--spacing-control-y) last:border-b-0"
                >
                  <PermissionMark kind={kind} label={markLabel[kind]} />
                  <span className="min-w-0">
                    <span className="text-(--el-text) font-sans text-[13px] font-medium">
                      {t(permission.labelKey)}
                    </span>{' '}
                    <span className="text-(--el-text-muted) font-sans text-[12.5px] leading-relaxed">
                      {t(permission.descriptionKey)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
