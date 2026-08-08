import { useTranslations } from 'next-intl';
import type { PermissionDomainDTO } from '@/lib/dto/permissions';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { PermissionMark } from './PermissionMark';

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
// lookup, so a missing string is a visible i18n path in the DOM that the unit
// suite fails on — not a `permissions.work_item:edit` shipped to a customer.

export function PermissionGroups({
  domains,
  held,
}: {
  domains: PermissionDomainDTO[];
  /** The keys this role holds. Everything else in `domains` renders withheld. */
  held: readonly PermissionKey[];
}) {
  const t = useTranslations();
  const tRoles = useTranslations('settings.rolesPage');
  const holds = new Set<PermissionKey>(held);

  return (
    <>
      {domains.map((group) => (
        <div key={group.domain}>
          <div className="border-(--el-border-soft) bg-(--el-muted) text-(--el-text-faint) border-b px-(--spacing-card-padding) py-(--spacing-control-y) font-sans text-[11px] font-semibold tracking-[0.06em] uppercase">
            {t(group.labelKey)}
          </div>
          <ul className="list-none">
            {group.permissions.map((permission) => {
              const isHeld = holds.has(permission.key);
              return (
                <li
                  key={permission.key}
                  data-permission={permission.key}
                  className="border-(--el-border-soft) grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-3 border-b px-(--spacing-card-padding) py-(--spacing-control-y) last:border-b-0"
                >
                  <PermissionMark
                    kind={isHeld ? 'held' : 'withheld'}
                    label={isHeld ? tRoles('mark.held') : tRoles('mark.notHeld')}
                  />
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
