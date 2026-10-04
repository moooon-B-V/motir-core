'use client';

import { useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { GuideTodoCanvas } from '@/components/planning/GuideTodoCanvas';
import { GuideRail } from '@/components/planning/GuideRail';
import { useGuideConversation, type GuideTodoAccess } from '@/lib/hooks/useGuideConversation';
import { deriveGuideView } from '@/lib/planning/guideView';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { useCoordinatedRefresh } from '@/lib/navigation/coordinatedRefresh';
import { listTodosAction, setTodoDoneAction } from '@/app/(authed)/items/[key]/todoActions';

// THE GUIDE MODE's host (Story MOTIR-7459 · MOTIR-7466) — the room the Guide me
// through door opens, on the overlay's shipped frame (`PlanningWorkspace`, the
// resizable split; design MOTIR-7462 § What it composes, unchanged). The canvas
// pane is the guided card's to-do list (`GuideTodoCanvas`), the chat pane is the
// guide conversation (`GuideRail`), and both draw ONE derived view
// (`deriveGuideView`), so they cannot disagree about the list or the step.
//
// PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`): a landed turn writes the
// card through its services. The canvas is a client island and re-reads its rows
// itself (the hook does, after every settle); the item page underneath is
// server-rendered and takes the shell's coordinated `router.refresh()` when the
// overlay closes, so the page the reader returns to shows what the walk did.

const TODOS: GuideTodoAccess = { list: listTodosAction, setDone: setTodoDoneAction };

export interface GuideWorkspaceHostProps {
  projectName: string;
  /** The guided card, as the overlay's anchor read resolved it. */
  card: PlanningTarget;
  onClose: () => void;
}

export function GuideWorkspaceHost({ projectName, card, onClose }: GuideWorkspaceHostProps) {
  const t = useTranslations('planningWorkspace');
  const tg = useTranslations('planningWorkspace.guide');
  const refresh = useCoordinatedRefresh();
  const { state, send, retry, reloadRows, setRowDone } = useGuideConversation({
    itemKey: card.identifier,
    workItemId: card.id,
    todos: TODOS,
  });

  const view = useMemo(
    () => deriveGuideView(state.session?.turns ?? [], state.rows, { idle: state.phase === 'idle' }),
    [state.session, state.rows, state.phase],
  );
  const title = view.editedTitle ?? card.title;

  // The page underneath is the card's own: when the guide goes away — by Close,
  // Esc, the scrim or Back alike — re-read it, so the list, the status and the
  // title it shows are the ones this walk left.
  useEffect(() => () => refresh(), [refresh]);

  return (
    <PlanningWorkspace
      className="h-full w-full"
      resizable
      proposalPresent={false}
      canvas={
        <div className="flex h-full min-h-0 flex-col bg-(--el-canvas)">
          <div className="flex items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-4 w-4 shrink-0" aria-hidden />
              {t('close')}
              <kbd className="ml-1 rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[0.6875rem] text-(--el-text-secondary)">
                {t('escKey')}
              </kbd>
            </button>
            {/* THE CRUMB NAMES THE CARD (design § What guide mode changes, 2):
                project / KEY title, the key in the identifier ink, the title
                truncating — and the title the walk last set, marked until the
                next turn when it changed this turn (panel 7). */}
            <span className="flex min-w-0 items-baseline gap-1.5 text-sm" data-testid="guide-crumb">
              <span className="shrink-0 font-semibold text-(--el-text)">{projectName}</span>
              <span className="shrink-0 text-(--el-text-secondary)" aria-hidden>
                /
              </span>
              <span className="shrink-0 font-mono text-xs text-(--el-text-identifier)">
                {card.identifier}
              </span>
              <span
                data-testid="guide-crumb-title"
                className={`truncate font-semibold text-(--el-text) ${
                  view.titleEditedNow
                    ? 'guide-title--edited rounded-(--radius-kbd) bg-(--el-diff-added) px-1'
                    : ''
                }`}
              >
                {title}
              </span>
            </span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <GuideTodoCanvas
              view={view}
              // The door asserted `work_item:edit` before the guide opened, and the
              // to-do action asserts it again on every tick.
              canTick
              onSetDone={(id, done) => void setRowDone(id, done)}
              onSave={() => void send(tg('saveTurn'))}
              busy={state.phase !== 'idle'}
              tickError={state.tickError}
            />
          </div>
        </div>
      }
      chat={
        <GuideRail
          card={{ ...card, title }}
          session={state.session}
          view={view}
          phase={state.phase}
          errorCode={state.errorCode}
          outOfCredits={state.outOfCredits}
          markers={state.markers}
          onSend={(text, attachmentIds) => void send(text, attachmentIds)}
          onRetry={() => void retry()}
          onReload={() => void reloadRows()}
        />
      }
    />
  );
}
