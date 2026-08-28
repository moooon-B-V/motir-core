'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import type { PermissionDomainDTO, RoleCatalogDTO } from '@/lib/dto/permissions';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { PROJECT_ASSIGNABLE_ROLES, type ProjectRole } from '@/lib/projects/roles';

// The role EDITOR (Story MOTIR-2257 · Subtask MOTIR-2483) — ONE component behind
// two routes, built to `design/projects/roles-permissions.mock.html` panel 3.
//
// ⚠️ A PAGE, NOT A DIALOG, AND THE ASSET PAID TO LEARN IT. A revision that used
// a modal measured **2165px tall in a 1200×900 viewport — 2.4× the height it had
// to fit in**, of which 1675px was the permission list. A form that long is a
// page, and being a page buys three things a dialog could not: the same full
// width the detail screen has (so every description sits on one line), ONE
// layout for one catalog (this list is the detail screen's list with its marks
// swapped for checkboxes — not a second grammar), and a pinned action bar.
//
// ⚠️ `Start from` SEEDS THE GRID AND IS NOT STORED (Yue, 2026-08-09). It exists
// so an author does not face 28 blank checkboxes — a quiz rather than freedom —
// and for no other reason. Nothing records the pick, so:
//   * it is sent to no endpoint (the body is `{ name, permissions }`);
//   * it is ABSENT on the edit route, because there is no base to show;
//   * a permission is held or not held — ONE checked state, no provenance.
//
// ⚠️ THE PINNED BAR HAS A TRAP THE ASSET ALSO PAID FOR. `position: sticky` pins
// against the nearest SCROLLING ancestor — `AppLayout`'s `<main>` here — and ANY
// ancestor between that and the bar which sets `overflow` to anything but
// `visible` kills it SILENTLY: the element keeps `position: sticky` in its
// computed style and simply never pins. So this page adds no clipping wrapper,
// and `tests/settings/roleEditor.test.tsx` asserts the pinning by scrolling
// rather than by reading the class.

export interface RoleEditorProps {
  projectKey: string;
  /** The role-gated rows, grouped exactly as the detail screen groups them. */
  domains: PermissionDomainDTO[];
  /** Every role in the project — the built-ins are what `Start from` offers. */
  catalog: RoleCatalogDTO;
  /** Present on the EDIT route; absent on `new`. */
  role?: { id: string; name: string; permissions: PermissionKey[] };
}

export function RoleEditor({ projectKey, domains, catalog, role }: RoleEditorProps) {
  const t = useTranslations('settings.rolesPage');
  const tCatalog = useTranslations();
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const isEdit = role !== undefined;
  const [name, setName] = useState(role?.name ?? '');
  const [held, setHeld] = useState<ReadonlySet<PermissionKey>>(
    () => new Set(role?.permissions ?? []),
  );
  const [formError, setFormError] = useState<string | null>(null);

  // The built-ins' sets, for the `Start from` seed. Read off the catalog the
  // server already sent — this component imports no role constant of its own,
  // so the day a built-in's set changes there is nothing here to update.
  const builtInSets = useMemo(() => {
    const map = new Map<ProjectRole, PermissionKey[]>();
    for (const candidate of catalog.roles) {
      if (candidate.builtInRole) map.set(candidate.builtInRole, candidate.permissions);
    }
    return map;
  }, [catalog.roles]);

  const total = catalog.roleGatedPermissionCount;

  function seedFrom(base: ProjectRole) {
    // Replaces the pre-ticked set. Deliberately a REPLACE and not a merge: the
    // picker's promise is "start from this role", and a merge would make a
    // second pick mean something the label does not say.
    setHeld(new Set(builtInSets.get(base) ?? []));
  }

  function toggle(key: PermissionKey, next: boolean) {
    setHeld((current) => {
      const updated = new Set(current);
      if (next) updated.add(key);
      else updated.delete(key);
      return updated;
    });
  }

  function save() {
    setFormError(null);
    startTransition(async () => {
      const permissions = [...held];
      const res = await fetch(
        isEdit
          ? `/api/projects/${projectKey}/roles/${role.id}`
          : `/api/projects/${projectKey}/roles`,
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          // ⚠️ THE SAME BODY EITHER WAY, and deliberately so: a role IS its name
          // and its set, so create and edit carry the identical shape. NO
          // `basedOn` — the `Start from` pick is an authoring convenience and is
          // not part of the role (Yue, 2026-08-09).
          body: JSON.stringify({ name, permissions }),
        },
      );

      if (res.ok) {
        const body = (await res.json()) as { role: { id: string } };
        toast({ variant: 'success', title: isEdit ? t('toast.saved') : t('toast.created') });
        // Land on the role that was just saved, showing what was saved.
        router.push(`/settings/project/roles/${body.role.id}`);
        router.refresh();
        return;
      }

      // Every refusal has a drawn outcome — none is a silent no-op. A taken name
      // and a cap reached belong ON the form, with the author's input intact; a
      // lost permission is not a form problem, so it goes to the page.
      const body = (await res.json().catch(() => ({}))) as { code?: string; limit?: number };
      if (body.code === 'ROLE_NAME_TAKEN') setFormError(t('error.nameTaken', { name }));
      else if (body.code === 'ROLE_LIMIT_REACHED')
        setFormError(t('error.capReached', { limit: body.limit ?? 0 }));
      else if (body.code === 'INVALID_ROLE_NAME') setFormError(t('error.invalidName'));
      else if (res.status === 403 || res.status === 404) {
        toast({ variant: 'error', title: t('error.noLongerAllowed') });
        router.refresh();
      } else toast({ variant: 'error', title: t('error.generic') });
    });
  }

  const canSubmit = name.trim().length > 0 && !isPending;

  return (
    <div className="flex flex-col">
      <p className="text-(--el-text-secondary) mb-2 font-mono text-[11px] tracking-[0.02em]">
        {t('editorCrumbs', { roleName: isEdit ? role.name : t('newRole') })}
      </p>

      <Link
        href="/settings/project/roles"
        className="text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) mb-3 inline-flex w-fit items-center gap-1.5 rounded-(--radius-control) font-sans text-[12.5px] font-medium focus-visible:ring-2"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t('allRoles')}
      </Link>

      <header className="mb-5 flex flex-col gap-1">
        <h1 className="text-(--el-text) font-serif text-2xl font-semibold">
          {isEdit ? t('editRoleTitle') : t('createRoleTitle')}
        </h1>
        <p className="text-(--el-text-secondary) max-w-[62ch] font-sans text-[13px] leading-relaxed">
          {t('editorLede')}
        </p>
      </header>

      <div className="mb-1.5 flex flex-wrap items-end gap-3.5">
        <label className="flex min-w-[240px] flex-col gap-1.5">
          <span className="text-(--el-text-secondary) font-sans text-[12.5px] font-medium">
            {t('nameLabel')}
          </span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            disabled={isPending}
            aria-label={t('nameLabel')}
          />
        </label>

        {/* ABSENT on the edit route — nothing was stored, so there is nothing to
            show and nothing that could be changed. */}
        {!isEdit ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-(--el-text-secondary) font-sans text-[12.5px] font-medium">
              {t('startFrom')}
            </span>
            <select
              defaultValue=""
              disabled={isPending}
              aria-label={t('startFrom')}
              onChange={(e) => {
                const base = PROJECT_ASSIGNABLE_ROLES.find((r) => r === e.target.value);
                if (base) seedFrom(base);
              }}
              className="border-(--el-input-border) bg-(--el-card) text-(--el-text) h-(--height-input) rounded-(--radius-input) border px-(--spacing-input-x) font-sans text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <option value="" disabled>
                {t('startFromPlaceholder')}
              </option>
              {PROJECT_ASSIGNABLE_ROLES.map((base) => (
                <option key={base} value={base}>
                  {tCatalog(`settings.roles.${base}.name`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <p className="text-(--el-text-secondary) mb-4 max-w-[68ch] font-sans text-xs leading-relaxed">
        {isEdit ? t('editorHintEdit') : t('editorHintNew')}
      </p>

      {formError ? (
        <p
          role="alert"
          className="text-(--el-danger-on-surface) mb-4 font-sans text-[12.5px]"
          data-testid="role-editor-error"
        >
          {formError}
        </p>
      ) : null}

      <div className="border-(--el-border) bg-(--el-card) overflow-hidden rounded-(--radius-card) border shadow-(--shadow-card)">
        {domains.map((group) => (
          <div key={group.domain}>
            <div className="border-(--el-border-soft) bg-(--el-muted) text-(--el-text-secondary) border-b px-(--spacing-card-padding) py-(--spacing-control-y) font-sans text-[11px] font-semibold tracking-[0.06em] uppercase">
              {tCatalog(group.labelKey)}
            </div>
            <ul className="list-none">
              {group.permissions.map((permission) => (
                <li
                  key={permission.key}
                  data-permission={permission.key}
                  className="border-(--el-border-soft) grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2 border-b px-(--spacing-card-padding) py-(--spacing-control-y) last:border-b-0"
                >
                  <Checkbox
                    checked={held.has(permission.key)}
                    onChange={(next) => toggle(permission.key, next)}
                    label={tCatalog(permission.labelKey)}
                    disabled={isPending}
                  />
                  <span className="min-w-0">
                    <span className="text-(--el-text) font-sans text-[13px] font-medium">
                      {tCatalog(permission.labelKey)}
                    </span>{' '}
                    <span className="text-(--el-text-secondary) font-sans text-xs">
                      {tCatalog(permission.descriptionKey)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* THE PINNED BAR. `sticky bottom-0` against `<main>`; the last child, so
          at full scroll it returns to its static position with every row above
          it and no trailing spacer is needed. Do NOT wrap this page in a
          clipping container — see the header note. */}
      <div
        data-testid="role-editor-actionbar"
        className="border-(--el-border) bg-(--el-card) sticky bottom-0 mt-5 flex items-center justify-between gap-4 rounded-(--radius-card) border px-(--spacing-card-padding) py-(--spacing-control-y) shadow-(--shadow-elevated)"
      >
        <span
          className="text-(--el-text-secondary) font-mono text-xs"
          data-testid="role-editor-count"
        >
          {t('permissionCount', { held: held.size, total })}
        </span>
        <span className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            onClick={() => router.push('/settings/project/roles')}
            disabled={isPending}
          >
            {tc('cancel')}
          </Button>
          <Button variant="primary" onClick={save} disabled={!canSubmit} loading={isPending}>
            {isEdit ? t('saveRole') : t('createRole')}
          </Button>
        </span>
      </div>
    </div>
  );
}
