'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Cloud, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { repositoryRowHref } from '@/lib/projectRepos/repositoryAnchor';
import { formatRunInstant } from '@/lib/runs/runClock';
import { relativeLabel } from '@/components/github/RepairFixPart';
import { HostedModelPicker } from './HostedModelPicker';
import { useHostedRun, type ContinueHostedRefusal } from './HostedRunProvider';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// THE CONTINUE HOSTED DOOR (Story MOTIR-6527 · MOTIR-6796), built to
// `design/runs/design-notes.md` § Continue hosted, Panels C1–C5
// (`design/runs/development--continue-hosted.mock.html`, approved on MOTIR-6789).
//
// ⚠️ RUN HOSTED'S ROW, NOT A SECOND ONE: the shipped `HostedModelPicker` then a
// primary `Button` with the `Cloud` glyph, reading the provider's ONE model list.
// `flex-wrap` is the one addition, so at ~400px the button drops under the picker.
//
// ⚠️ ITS ANSWERS ARE ITS OWN. A refusal is drawn directly under this door, in the
// continue part — never in the Run section's body, whose notices answer ITS door.

/** The picker and the button — the part's primary action (C1–C3, C4a). */
export function ContinueHostedDoor() {
  const t = useTranslations('github.development.continue.hosted');
  const tDoor = useTranslations('runs.hosted.door');
  const door = useHostedRun();
  if (!door || !door.continueTarget) return null;

  const modelsReady = door.models.state === 'ok' && door.models.models.length > 0;
  const parent = door.continueTarget !== door.itemKey ? door.continueTarget : null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="continue-hosted-door">
      <HostedModelPicker
        models={door.models}
        value={door.selectedModel}
        onChange={door.selectModel}
        disabled={door.continueStarting}
      />
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={!modelsReady || door.continueStarting || !door.selectedModel}
        loading={door.continueStarting}
        onClick={() => void door.startContinue()}
        leftIcon={<Cloud className="size-3.5" aria-hidden="true" />}
        data-testid="continue-hosted"
      >
        {door.continueStarting
          ? tDoor('starting')
          : parent
            ? t('buttonParent', { key: parent })
            : t('button')}
      </Button>
    </div>
  );
}

/** What the door answered — kept after the part re-reads its view (C5a). */
export function ContinueHostedNotice() {
  const door = useHostedRun();
  if (!door) return null;
  const models = door.models;
  return (
    <>
      {door.continueRefusal ? <Refusal refusal={door.continueRefusal} /> : null}
      {door.continueTarget && models.state === 'unavailable' ? <ModelsUnavailable /> : null}
      {door.continueTarget && models.state === 'ok' && models.models.length === 0 ? (
        <ModelsEmpty />
      ) : null}
    </>
  );
}

function ModelsUnavailable() {
  const t = useTranslations('runs.hosted.picker');
  const door = useHostedRun();
  return (
    <Notice testId="continue-hosted-models-unavailable">
      <span>{t('unavailableBody')}</span>
      <Button type="button" variant="secondary" size="sm" onClick={door?.reloadModels}>
        {t('retry')}
      </Button>
    </Notice>
  );
}

function ModelsEmpty() {
  const t = useTranslations('runs.hosted.picker');
  return (
    <Notice testId="continue-hosted-models-empty">
      <span>{t('emptyBody')}</span>
    </Notice>
  );
}

const bold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

function When({ iso }: { iso: string }) {
  const locale = useLocale();
  // Read ONCE per mount, as the continue part's own clock is (ContinuePart.tsx).
  const [now] = useState(() => Date.now());
  return (
    <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso)}>
      {relativeLabel(iso, locale, now)}
    </time>
  );
}

function Refusal({ refusal }: { refusal: ContinueHostedRefusal }) {
  const routes = useReaderRoutes();
  const t = useTranslations('github.development.continue.hosted.refused');
  const tRun = useTranslations('runs.hosted.refused');
  const door = useHostedRun();
  const nothing = tRun('notReady.body');
  const testId = `continue-hosted-refused-${refusal.kind}`;

  if (refusal.kind === 'notWritable') {
    const count = refusal.repositories.length;
    return (
      <Notice testId={testId}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="font-semibold">
            {refusal.total !== null
              ? tRun('notWritable.lead', { count, total: refusal.total })
              : tRun('notWritable.leadNoTotal', { count })}
          </p>
          <p>{tRun('notWritable.detail')}</p>
          <ul className="flex flex-col">
            {refusal.repositories.map((r) => (
              <li
                key={r.repository}
                className="flex flex-col gap-0.5 border-t border-(--el-border-soft) py-1.5 first:border-t-0"
              >
                <span className="font-mono text-xs font-semibold">{r.repository}</span>
                <span>{r.reason}</span>
                <Link
                  className="self-start text-(--el-link) underline"
                  href={repositoryRowHref(r.repository)}
                >
                  {tRun('notWritable.open')}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Notice>
    );
  }

  let title: ReactNode;
  let body: ReactNode = nothing;
  switch (refusal.kind) {
    case 'taken': {
      const mine = refusal.holder !== null && refusal.holder.id === door?.viewerId;
      const when = () => (refusal.startedAt ? <When iso={refusal.startedAt} /> : null);
      title = mine
        ? t.rich('takenByYou', { when })
        : t.rich('taken', { name: refusal.holder?.name ?? '—', b: bold, when });
      break;
    }
    case 'runAlive':
      title = t.rich('runAlive', { name: refusal.holder?.name ?? '—', b: bold });
      break;
    case 'nothingPushed':
      title = t('nothingPushed');
      break;
    case 'useFix':
      title = t('useFix');
      break;
    case 'notInProgress':
      title = t('notInProgress');
      break;
    case 'noDeadRun':
      title = t('noDeadRun');
      break;
    case 'theParent': {
      const key = refusal.parentKey ?? '';
      title = t.rich('theParent', {
        key,
        link: (chunks) => (
          <Link
            href={routes.item(key)}
            className="font-medium text-(--el-link) underline-offset-2 hover:underline"
          >
            {chunks}
          </Link>
        ),
      });
      break;
    }
    case 'outOfCredits':
      title = tRun('outOfCredits.title');
      body = t('outOfCredits.body');
      break;
    case 'modelNotOffered':
      title = tRun('modelNotOffered.title', { model: refusal.model });
      body = tRun('modelNotOffered.body');
      break;
    default:
      title = tRun(`${refusal.kind}.title`);
      body = tRun(`${refusal.kind}.body`);
  }
  return (
    <Notice testId={testId}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        <p>{body}</p>
      </div>
    </Notice>
  );
}

/** HostedDoorNotices' `notice warn` — nothing failed that the reader did, nothing was spent. */
function Notice({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
