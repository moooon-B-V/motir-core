'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { ContentSectionCard } from './ContentSectionCard';
import {
  LinkErrorDoor,
  LinkErrorForm,
  MonitorErrorsLinkProvider,
  useAnnounceNoLinkDoor,
  useMonitorErrorsDoor,
} from './MonitorErrorsLinkControl';
import {
  MonitorErrorsList,
  MonitorErrorsLoadFailed,
  canWriteErrors,
  errorsSectionState,
} from './MonitorErrorsSection';

// The Errors section's HOST (Story MOTIR-4932 · Subtasks MOTIR-5732 / MOTIR-5744)
// — the one place that decides, from the late read, which of §14's states the
// section is in, and mounts the linking doors inside it.
//
// | the read                               | renders                                      |
// |----------------------------------------|----------------------------------------------|
// | no link, nobody asked                  | NOTHING — the page is unchanged (panel 5a)   |
// | no link, the ⋯ row was chosen          | the section, picker open, the empty line (5c)|
// | a failed read, project has a monitor   | the section's ErrorState (panel 10)          |
// | one or more links                      | the rows, and `+ Link error` for an editor   |
//
// The ⋯ row is the only way into the no-link state, and it appears only where
// the no-link door APPLIES (an editor, a monitored project, no link) — which this
// host announces to the page, because the menu renders in tier one and cannot see
// this read.

export function MonitorErrorsCard({
  links,
  hasConnection,
  canEdit,
  workItemId,
  identifier,
  unlinkAction,
}: {
  links: MonitorIssueLinkDto[] | null;
  hasConnection: boolean;
  canEdit: boolean;
  workItemId: string;
  identifier: string;
  unlinkAction: Parameters<typeof MonitorErrorsList>[0]['unlinkAction'];
}) {
  const t = useTranslations('monitorErrors');
  const door = useMonitorErrorsDoor();
  const state = errorsSectionState(links, hasConnection);
  const canWrite = canWriteErrors(canEdit, hasConnection);
  const noLinkDoor = canWrite && links !== null && links.length === 0;
  useAnnounceNoLinkDoor(noLinkDoor);

  const requested = (door?.requested ?? false) && noLinkDoor;
  // Once the read returns a link, the request has done its job — the rows hold
  // the section up now. Cleared HERE rather than at the link, so the section does
  // not drop out in the gap before the refreshed read lands.
  const clearRequest = door?.clearRequest;
  const hasLinks = (links?.length ?? 0) > 0;
  useEffect(() => {
    if (hasLinks) clearRequest?.();
  }, [hasLinks, clearRequest]);

  if (state === 'hidden' && !requested) return null;

  return (
    <MonitorErrorsLinkProvider
      // A new mount per state, so the requested path opens the picker and the
      // rows path starts closed.
      key={requested ? 'requested' : state}
      workItemId={workItemId}
      identifier={identifier}
      initiallyOpen={requested}
      onClosed={requested ? clearRequest : undefined}
    >
      <ContentSectionCard
        title={t('title')}
        subtitle={t('gloss')}
        headerRight={canWrite && state === 'rows' ? <LinkErrorDoor /> : undefined}
      >
        {state === 'failed' ? (
          <MonitorErrorsLoadFailed />
        ) : (
          <>
            {canWrite ? <LinkErrorForm /> : null}
            {state === 'rows' && links ? (
              <MonitorErrorsList
                links={links}
                canWrite={canWrite}
                unlinkAction={unlinkAction}
                workItemId={workItemId}
                identifier={identifier}
              />
            ) : (
              <p className="font-sans text-sm text-(--el-text-secondary)">{t('empty')}</p>
            )}
          </>
        )}
      </ContentSectionCard>
    </MonitorErrorsLinkProvider>
  );
}
