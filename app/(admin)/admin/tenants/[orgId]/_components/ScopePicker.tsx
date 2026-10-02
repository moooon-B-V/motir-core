'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The Usage & cost tab's SCOPE PICKER (MOTIR-7288, design D8): the whole org, any
 * workspace, or any project inside one — on the LEFT of the toolbar row. The scope
 * lives in the URL (`?scope=workspace:<id>|project:<id>`); every other parameter
 * (the tab, the period, ← Tenants' `from`) is kept, and a list cursor is dropped.
 */
export function ScopePicker({
  value,
  scopes,
  labels,
}: {
  value: string;
  scopes: { id: string; name: string; projects: { id: string; name: string }[] }[];
  labels: { scope: string; organization: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (next: string) => {
    const query = new URLSearchParams(params.toString());
    if (next === 'organization') query.delete('scope');
    else query.set('scope', next);
    query.delete('cursor');
    router.push(`${pathname}?${query.toString()}`);
  };

  return (
    <label className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
      <span>{labels.scope}</span>
      <select
        value={value}
        onChange={(e) => go(e.target.value)}
        className="h-(--height-input) max-w-[20rem] rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-2 text-(--el-text)"
      >
        <option value="organization">{labels.organization}</option>
        {scopes.map((ws) => (
          <optgroup key={ws.id} label={ws.name}>
            <option value={`workspace:${ws.id}`}>{ws.name}</option>
            {ws.projects.map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {`${ws.name} › ${p.name}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
