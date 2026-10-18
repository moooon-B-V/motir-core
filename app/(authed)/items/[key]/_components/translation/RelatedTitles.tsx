'use client';

import type { ReactNode } from 'react';
import { SurfaceTitleTranslationProvider } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { useTranslationContext } from './TranslationProvider';

// The titles of OTHER work items inside an opened item — the child list, the
// parent breadcrumb, the relationships, the parent field, the readiness ancestor,
// the child graph (Story MOTIR-7738 · MOTIR-8834). They follow this item's host:
// the same auto-translate context, and its single Show original — so one page has
// one control. Mounted INSIDE the item's `TranslationProvider`; without one (a
// Visitor, a failed offer read) it renders its children untouched.

export function RelatedTitles({
  projectKey,
  children,
}: {
  projectKey: string;
  children: ReactNode;
}) {
  const host = useTranslationContext();
  if (!host?.auto) return <>{children}</>;
  // Until the host has run (nothing on the item itself differs) there is no view to
  // follow: the related titles are translated, and the host's first press is theirs.
  const view = host.state.pressed ? host.state.view : 'translated';
  return (
    <SurfaceTitleTranslationProvider projectKey={projectKey} context={host.auto} followView={view}>
      {children}
    </SurfaceTitleTranslationProvider>
  );
}
