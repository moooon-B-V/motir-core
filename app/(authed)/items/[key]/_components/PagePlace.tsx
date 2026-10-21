'use client';

import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Folder } from 'lucide-react';
import { foldSegments, type BreadcrumbSegment } from '@/components/pages/tree/PageBreadcrumb';
import type { WorkItemPageLinkPlaceDto } from '@/lib/dto/pageLinks';

// A page's PLACE as a label (Story MOTIR-7565 · MOTIR-7575), shared by the Pages
// section's rows and the Link page form's candidates (MOTIR-9199) so the two draw
// one breadcrumb vocabulary rather than a second copy.

/** The row's place as breadcrumb segments, root-first, ending at the PARENT. */
function placeSegments(
  place: WorkItemPageLinkPlaceDto,
  rootLabel: string,
  untitled: string,
): BreadcrumbSegment[] {
  return [
    { kind: 'root', id: 'root', label: rootLabel, href: '' },
    ...place.folderPath.map(
      (name, i): BreadcrumbSegment => ({ kind: 'folder', id: String(i), label: name, href: '' }),
    ),
    ...(place.parentPageTitle === null
      ? []
      : [
          {
            kind: 'page',
            id: 'parent',
            label: place.parentPageTitle || untitled,
            href: '',
          } satisfies BreadcrumbSegment,
        ]),
  ];
}

export function Place({ place }: { place: WorkItemPageLinkPlaceDto }) {
  const t = useTranslations('pages');
  const segments = placeSegments(place, t('index.title'), t('untitled'));
  const { head, hidden, tail } = foldSegments(segments);
  const separator = (
    <li aria-hidden className="flex items-center">
      <ChevronRight className="h-3 w-3 shrink-0 text-(--el-icon-muted)" />
    </li>
  );
  const segment = (s: BreadcrumbSegment, index: number) => (
    <Fragment key={`${s.kind}:${s.id}`}>
      {index > 0 ? separator : null}
      <li className="inline-flex max-w-[180px] min-w-0 items-center gap-1">
        {s.kind === 'folder' ? (
          <>
            <Folder className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">{t('tree.breadcrumb.folder')}</span>
          </>
        ) : null}
        <span className="truncate">{s.label}</span>
      </li>
    </Fragment>
  );
  return (
    <ol
      aria-label={t('tree.breadcrumb.label')}
      title={hidden.length > 0 ? segments.map((s) => s.label).join(' › ') : undefined}
      className="m-0 mt-0.5 flex min-w-0 list-none items-center gap-1 p-0 text-xs text-(--el-text-secondary)"
    >
      {head.map(segment)}
      {hidden.length > 0 ? (
        <>
          {separator}
          <li className="inline-flex items-center">…</li>
        </>
      ) : null}
      {tail.map((s) => segment(s, 1))}
    </ol>
  );
}
