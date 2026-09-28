'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleDot, Columns3, Map, Sparkles, Stamp, Waypoints } from 'lucide-react';
import { Sidebar, type SidebarItem } from '@/components/ui/Sidebar';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import { parseVisitorPath, visitorViewPath, type VisitorView } from '@/lib/visitor/routes';

// THE VISITOR's rail (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641 panel 5):
// the member rail's six rows a Visitor has a view for, in the member rail's own
// order, with its own labels and glyphs — each an ordinary link to the Visitor
// path. Nothing else: no Workbench, Ready, Backlog, Dashboard, Triage, Reports or
// Code, no Settings and no Resume onboarding (panel 3). The tree is not a row; it
// is the Work Items List / Tree switch, so `items`, `tree` and an item's own page
// all light the Work Items row.

const ROWS: { views: readonly VisitorView[]; to: VisitorView; label: string; icon: ReactNode }[] = [
  { views: ['items', 'tree'], to: 'items', label: 'nav.issues', icon: <CircleDot /> },
  { views: ['runs'], to: 'runs', label: 'nav.runs', icon: <Waypoints /> },
  { views: ['board'], to: 'board', label: 'nav.boards', icon: <Columns3 /> },
  { views: ['roadmap'], to: 'roadmap', label: 'nav.roadmap', icon: <Map /> },
  { views: ['plans'], to: 'plans', label: 'nav.plans', icon: <Sparkles /> },
  { views: ['approvals'], to: 'approvals', label: 'nav.approvalRecords', icon: <Stamp /> },
];

export function VisitorRail({
  identifier,
  variant = 'rail',
  helpMenu,
}: {
  identifier: string;
  /** `rail` (≥md, follows the collapse store, carries the footer) or `drawer`. */
  variant?: 'rail' | 'drawer';
  /** The rail footer's Help trigger, built by the layout (the member rail's shape). */
  helpMenu?: ReactNode;
}) {
  const t = useTranslations('shell');
  const pathname = usePathname();
  const [storeCollapsed] = useSidebarCollapsed();
  const isDrawer = variant === 'drawer';
  const collapsed = isDrawer ? false : storeCollapsed;
  const current = parseVisitorPath(pathname)?.view ?? null;

  const items: SidebarItem[] = ROWS.map((row) => ({
    icon: row.icon,
    label: t(row.label),
    href: visitorViewPath(identifier, row.to),
    active: current !== null && row.views.includes(current),
  }));

  const footer = isDrawer ? undefined : (
    <div
      className={
        collapsed ? 'flex flex-col items-center gap-1' : 'flex items-center justify-between'
      }
    >
      {helpMenu}
      <SidebarToggle variant="footer" />
    </div>
  );

  return (
    <Sidebar
      sections={[{ id: 'visitor', items }]}
      footer={footer}
      collapsed={isDrawer ? false : undefined}
    />
  );
}
