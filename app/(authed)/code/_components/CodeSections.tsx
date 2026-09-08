'use client';

import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { Segmented } from '@/components/ui/Segmented';
import { shallowPush } from '@/lib/navigation/shallowUrl';

// THE TWO SECTIONS, AND THE SWITCH BETWEEN THEM (Story MOTIR-1754 · MOTIR-1768).
//
// ⚠️ TWO, NOT THREE. The `Index` tab was retired on 2026-09-07
// (design/code-context §4): freshness is a property of the REPOSITORY and belongs
// on its row, and *"a tab is a room somebody goes to, and nobody goes to look at
// an index."* There is no second dataset to give a tab.
//
// ⚠️ AND THE SWITCH IS SHALLOW, WHICH IS A RULE RATHER THAN AN OPTIMISATION
// (CLAUDE.md § URL state the CLIENT reads). Both bodies are rendered by the
// server on this page load and handed in as props, so the target of a switch is
// already in the browser: `router.push` would re-run every await behind this
// page — the audit fan-out included — to show something already on screen.
// `shallowPush` syncs the URL through `history.pushState`, so a deep link, a
// reload and Back/forward all agree, and nothing is re-fetched.
//
// It is a PUSH and not a replace: Back should undo a tab change, which is the
// defect MOTIR-1549 was filed for on the roadmap toggle.
//
// ⚠️ NO PENDING AFFORDANCE. No spinner, no disabled segment, no skeleton — the
// same rule's second half. There is nothing to wait for, and drawing a wait
// manufactures one.

export type CodeSection = 'repositories' | 'health';

const SECTIONS: readonly CodeSection[] = ['repositories', 'health'];

/** The tab a URL asks for, or the default. Unknown values fall back rather than throw. */
export function sectionFromParam(raw: string | null | undefined): CodeSection {
  return SECTIONS.includes(raw as CodeSection) ? (raw as CodeSection) : 'repositories';
}

export function CodeSections({
  label,
  repositoriesLabel,
  healthLabel,
  repositories,
  health,
}: {
  label: string;
  repositoriesLabel: string;
  healthLabel: string;
  repositories: ReactNode;
  health: ReactNode;
}) {
  const params = useSearchParams();
  const [section, setSection] = useState<CodeSection>(() =>
    sectionFromParam(params.get('section')),
  );

  const select = (next: CodeSection): void => {
    setSection(next);
    const q = new URLSearchParams(params.toString());
    // `repositories` is the default, so it is the ABSENCE of the parameter
    // rather than a value — a URL that names the default is a URL that has to be
    // kept in step with it.
    if (next === 'repositories') q.delete('section');
    else q.set('section', next);
    const query = q.toString();
    shallowPush(query === '' ? '/code' : `/code?${query}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <Segmented<CodeSection>
        label={label}
        value={section}
        onChange={select}
        options={[
          { value: 'repositories', label: repositoriesLabel },
          { value: 'health', label: healthLabel },
        ]}
      />
      {/* ⚠️ BOTH BODIES STAY MOUNTED, and the hidden one is hidden with `hidden`
          rather than unmounted. Unmounting would throw away the Health island's
          state — its selected repository, its paged findings, its dismissal —
          every time somebody looked at the repository list, which is exactly the
          kind of loss a shallow switch exists to avoid. */}
      <div hidden={section !== 'repositories'}>{repositories}</div>
      <div hidden={section !== 'health'}>{health}</div>
    </div>
  );
}
