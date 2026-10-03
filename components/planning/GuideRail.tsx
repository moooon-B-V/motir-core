'use client';

import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  Check,
  CircleCheck,
  FilePenLine,
  GitPullRequest,
  History,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import { AiPaywall } from '@/components/ai/AiPaywall';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { Bubble } from '@/components/planning/PlanChangeRail';
import {
  GuideDropOverlay,
  GuideFileRefusals,
  GuideFilesNotSent,
  GuideFileTray,
  GuideSentFiles,
} from '@/components/planning/GuideTurnFiles';
import { GUIDE_FILES_MAX } from '@/lib/ai/guideFiles';
import { ALLOWED_UPLOAD_TYPES } from '@/lib/blob/allowlist';
import { useGuideTurnFiles } from '@/lib/hooks/useGuideTurnFiles';
import type { GuideAction } from '@/lib/ai/guideWorkItem';
import type { PlanChangeTurnDto, PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { GuidePersonMarker, GuidePhase } from '@/lib/hooks/useGuideConversation';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import {
  guideOutcomeLines,
  type GuideOutcomeLine,
  type GuideReply,
  type GuideView,
} from '@/lib/planning/guideView';

// THE GUIDE CONVERSATION in the overlay's rail (Story MOTIR-7459 · MOTIR-7466;
// design `planning-workspace--guide.mock.html`, every rail panel). It is the
// shipped rail's LANGUAGE — the `<aside>`, its head and mode `Pill`, `Bubble`,
// the act line, the marker line, the error block with *Try again*, the shipped
// paywall, and `PlanChangeComposer` — composed for a conversation with one
// intent. It is a sibling of `PlanChangeRail`, not a mode inside it, because
// none of that rail's plan machinery (targets, proposals, the gate, the
// mailbox) exists in a guide.
//
// A guide turn is drawn in the DEBUG turn's shape (MOTIR-7045): the user bubble,
// the assistant bubble rendering the handler's text through `MarkdownView` with
// `copyableCode` (the step card, the save-or-walk sentence, the dropped-action
// list all arrive as text), and an OUTCOME foot built from the turn's LANDED
// actions — never from the prose (`guideOutcomeLines`).
//
// ⚠️ EVERY REPLY BUTTON SENDS WORDS. Saving a list, walking it, closing the card
// and undoing a change each need the person's consent in a TURN (A2.3, A2.6), so
// each button sends a fixed sentence as a user turn. *Reload the card* is the one
// exception: it is a read, and sends nothing.
//
// FILES ON A TURN (Story MOTIR-7471 · MOTIR-7486; design MOTIR-7482). The rail
// owns the turn being written — its words AND its files — so the composer gains
// the attach control and image paste here, the rail itself is the drop target,
// and Send UPLOADS the queued files to the guided card before the turn is sent
// (A3.1). A failed upload sends nothing and keeps the words; Stop stops the
// send. The composer keeps its target search in guide mode (design review,
// 2026-10-03): a picked item is written into the message as its key.

export interface GuideRailProps {
  card: PlanningTarget;
  session: PlanChangeSessionDto | null;
  view: GuideView;
  phase: GuidePhase;
  errorCode: string | null;
  outOfCredits: boolean;
  markers: readonly GuidePersonMarker[];
  /** Send a turn. `attachmentIds` are files already on the card (A3.1). */
  onSend: (text: string, attachmentIds?: readonly string[]) => void;
  onRetry: () => void;
  onReload: () => void;
}

const REPLY_TURN_KEY: Record<Exclude<GuideReply, 'reload'>, string> = {
  save: 'saveTurn',
  walk: 'walkTurn',
  undo: 'undoTurn',
  closeYes: 'closeYesTurn',
  closeNo: 'closeNoTurn',
};

/** Typed refusals from the door, in the guide's own words; anything else is the
 *  guarantee every failed turn carries (A2.4). */
function errorKey(code: string): string {
  if (code === 'GUIDE_CARD_NOT_MANUAL') return 'errors.notManual';
  if (code === 'GUIDE_CARD_CLOSED') return 'errors.closed';
  if (code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') return 'errors.forbidden';
  return 'failed';
}

export function GuideRail({
  card,
  session,
  view,
  phase,
  errorCode,
  outOfCredits,
  markers,
  onSend,
  onRetry,
  onReload,
}: GuideRailProps) {
  const t = useTranslations('planningWorkspace');
  const tg = useTranslations('planningWorkspace.guide');
  const [draft, setDraft] = useState('');
  const turns = session?.turns ?? [];
  const userTurns = turns.filter((x) => x.role === 'user');
  const running = phase !== 'idle';
  const tf = useTranslations('planningWorkspace.guide.files');
  const files = useGuideTurnFiles(card.id);
  const [dragging, setDragging] = useState(false);
  const canAttach = !running && session !== null && !files.uploading;

  // The chip every outcome line names the card with — the thread's resolved
  // reference when it has one, else the card as the overlay read it, with its
  // title as the conversation last set it.
  const chipSummary: WorkItemRefSummaryDto = session?.workItemRefs[card.identifier] ?? {
    accessible: true,
    id: card.id,
    identifier: card.identifier,
    title: view.editedTitle ?? card.title,
    kind: card.kind,
    archived: false,
    status: null,
  };

  // Follow the newest line while the reader is at the bottom.
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, phase, markers.length, view.replies.length]);

  // The act line counts the files of the turn being read (panel 9's "Reading
  // your 2 files and MOTIR-9…").
  const lastUser = userTurns[userTurns.length - 1];
  const readingFiles = lastUser?.attachmentIds?.length ?? 0;

  /** Send the turn: upload its files first, then send it with their ids. */
  async function submitTurn(text: string) {
    if (files.files.length === 0) {
      if (!text) return;
      setDraft('');
      onSend(text);
      return;
    }
    const ids = await files.upload();
    if (!ids) return; // not sent — the words and the tray stay (panel 6)
    setDraft('');
    files.reset();
    onSend(text, ids);
  }

  /** A picked target is written into the message as its key. */
  function insertTarget(target: PlanningTarget) {
    setDraft((d) => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${target.identifier} `);
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const latestAssistantId = [...turns].reverse().find((x) => x.role === 'assistant')?.id ?? null;
  const markersAfter = (turnId: string | null) => markers.filter((m) => m.afterTurnId === turnId);

  return (
    <aside
      className="relative flex h-full min-h-0 flex-col border-l border-(--el-border) bg-(--el-surface)"
      aria-label={t('railLabel')}
      data-testid="guide-rail"
      // THE RAIL IS THE DROP TARGET (panel 3) — the canvas is not.
      onDragEnter={(e) => {
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
        files.add(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging ? <GuideDropOverlay cardKey={card.identifier} /> : null}
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="size-2 rounded-full bg-(--el-success)" aria-hidden="true" />
        <span className="font-mono text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {t('railLabel')}
        </span>
        <Pill tone="neutral" className="ml-auto" data-testid="planning-mode-chip">
          {t('mode.guide')}
        </Pill>
      </div>

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        role="log"
        data-testid="guide-rail-log"
      >
        <p className="text-center text-xs text-(--el-text-secondary)" data-testid="guide-opened">
          {tg('openedFrom', { key: card.identifier })}
        </p>
        {markersAfter(null).map((m) => (
          <PersonMarker key={m.id} marker={m} />
        ))}

        {turns.map((turn) => (
          <Fragment key={turn.id}>
            {/* A turn of files alone draws no empty bubble — its chips stand
                for it (A3.2). */}
            {turn.role === 'user' && turn.body.trim().length > 0 ? (
              <Bubble
                role="user"
                label={t('conversation.turn', {
                  n: userTurns.findIndex((u) => u.id === turn.id) + 1,
                })}
              >
                {turn.body}
              </Bubble>
            ) : null}
            {turn.role === 'user' && (turn.attachmentIds?.length ?? 0) > 0 ? (
              <GuideSentFiles
                attachmentIds={turn.attachmentIds ?? []}
                attachments={session?.attachments ?? {}}
              />
            ) : turn.role === 'assistant' ? (
              <GuideAssistantTurn
                turn={turn}
                view={view}
                chip={chipSummary}
                workItemRefs={session?.workItemRefs ?? {}}
              />
            ) : null}
            {turn.id === latestAssistantId && view.stale ? (
              <p
                data-testid="guide-stale"
                className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-notice-info-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-strong)"
              >
                <History className="mt-px size-3.5 flex-none" aria-hidden />
                <span>{tg('staleNotice', { key: card.identifier })}</span>
              </p>
            ) : null}
            {turn.id === latestAssistantId && view.replies.length > 0 ? (
              <ReplyRow
                replies={view.replies}
                onReply={(reply) =>
                  reply === 'reload' ? onReload() : onSend(tg(REPLY_TURN_KEY[reply]))
                }
              />
            ) : null}
            {markersAfter(turn.id).map((m) => (
              <PersonMarker key={m.id} marker={m} />
            ))}
          </Fragment>
        ))}

        {/* THE ACT LINE while Motir AI reads the card and its list (panel 1) —
            the shipped act rail's shape with its one live line. */}
        <div aria-live="polite" data-testid="guide-progress-line">
          {running ? (
            <ol className="flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2">
              <li className="flex items-start gap-2 text-xs text-(--el-text)">
                <Spinner size="sm" aria-hidden="true" />
                <span className="mt-px w-16 shrink-0 font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                  {t('conversation.act.reading')}
                </span>
                <span className="min-w-0 flex-1">
                  {readingFiles > 0
                    ? tf('reading', { count: readingFiles, key: card.identifier })
                    : tg('reading', { key: card.identifier })}
                </span>
              </li>
            </ol>
          ) : null}
        </div>

        {errorCode ? (
          <div className="flex flex-col items-start gap-2">
            <p
              role="alert"
              data-testid="guide-error"
              className="rounded-(--radius-card) bg-(--el-tint-rose) px-3 py-2 text-sm text-(--el-text-strong)"
            >
              {tg(errorKey(errorCode))}
            </p>
            {errorKey(errorCode) === 'failed' ? (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RefreshCw className="size-4" aria-hidden="true" />}
                onClick={onRetry}
                disabled={running}
              >
                {t('conversation.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {outOfCredits ? <AiPaywall triggeredOutOfCredits /> : null}
      </div>

      <PlanChangeComposer
        draft={draft}
        onDraftChange={setDraft}
        // The guide's target is fixed by the door, so a pick is not a target:
        // the search stays (MOTIR-7482's review) and writes the key into the
        // message instead.
        targets={[]}
        onAddTarget={insertTarget}
        onRemoveTarget={() => {}}
        onSubmit={(text) => void submitTurn(text)}
        clearOnSubmit={false}
        canSendEmpty={files.files.length > 0}
        readOnly={files.uploading}
        attach={{
          onFiles: (picked) =>
            files.add(
              picked.map((f) =>
                f.name
                  ? f
                  : new File([f], `${tf('pastedName')}.${f.type.split('/')[1] ?? 'png'}`, {
                      type: f.type,
                    }),
              ),
            ),
          atCap: files.files.length >= GUIDE_FILES_MAX,
          label: tf('attach'),
          tip: tf('attachTip'),
          capLabel: tf('cap'),
          accept: ALLOWED_UPLOAD_TYPES.join(','),
        }}
        running={
          files.uploading
            ? {
                line: tf('attaching', { count: files.files.length, key: card.identifier }),
                stopping: false,
                onStop: files.stop,
              }
            : null
        }
        beforeField={
          <>
            {files.notSent ? <GuideFilesNotSent cardKey={card.identifier} /> : null}
            <GuideFileRefusals refusals={files.refusals} onDismiss={files.dismissRefusal} />
            <GuideFileTray
              files={files.files}
              cardKey={card.identifier}
              uploading={files.uploading}
              onRemove={files.remove}
              onRetry={() => void submitTurn(draft.trim())}
            />
          </>
        }
        placeholder={t('conversation.composerPlaceholderGuide')}
        disabled={running || session === null}
      />
    </aside>
  );
}

function PersonMarker({ marker }: { marker: GuidePersonMarker }) {
  const tg = useTranslations('planningWorkspace.guide');
  return (
    <p className="text-center text-xs text-(--el-text-secondary)" data-testid="guide-person-marker">
      {tg(marker.done ? 'youTicked' : 'youUnticked', { n: marker.step })}
    </p>
  );
}

function ReplyRow({
  replies,
  onReply,
}: {
  replies: readonly GuideReply[];
  onReply: (reply: GuideReply) => void;
}) {
  const tg = useTranslations('planningWorkspace.guide');
  const primary = new Set<GuideReply>(['save', 'closeYes']);
  const label: Record<GuideReply, string> = {
    save: 'save',
    walk: 'walk',
    undo: 'undo',
    closeYes: 'closeYes',
    closeNo: 'closeNo',
    reload: 'reload',
  };
  return (
    <div className="flex flex-wrap gap-1.5 pl-9" data-testid="guide-replies">
      {replies.map((reply) => (
        <Button
          key={reply}
          variant={primary.has(reply) ? 'primary' : 'secondary'}
          size="sm"
          data-testid={`guide-reply-${reply}`}
          leftIcon={
            reply === 'save' ? (
              <Check className="size-4" aria-hidden />
            ) : reply === 'undo' ? (
              <Undo2 className="size-4" aria-hidden />
            ) : reply === 'reload' ? (
              <RefreshCw className="size-4" aria-hidden />
            ) : undefined
          }
          onClick={() => onReply(reply)}
        >
          {tg(label[reply])}
        </Button>
      ))}
    </div>
  );
}

const OUTCOME_GLYPH: Record<GuideOutcomeLine['kind'], typeof Check> = {
  ticked: Check,
  unticked: Check,
  saved: ListChecks,
  added: ListChecks,
  changed: ListChecks,
  removed: ListChecks,
  moved: ListChecks,
  edited: FilePenLine,
  commented: MessageSquare,
  closed: CircleCheck,
};

function GuideAssistantTurn({
  turn,
  view,
  chip,
  workItemRefs,
}: {
  turn: PlanChangeTurnDto;
  view: GuideView;
  chip: WorkItemRefSummaryDto;
  workItemRefs: PlanChangeSessionDto['workItemRefs'];
}) {
  const lines = guideOutcomeLines(turn.guide, view.rows, turn.seq);
  const edits = (turn.guide?.actions ?? []).filter(
    (a, i): a is Extract<GuideAction, { type: 'edit_item' }> =>
      a.type === 'edit_item' && turn.guide?.outcomes[i]?.outcome === 'landed',
  );
  return (
    <Bubble role="assistant" testId="guide-turn">
      <MarkdownView value={turn.body} workItemRefs={workItemRefs} copyableCode />
      {edits.map((edit, i) => (
        <EditStatement key={i} edit={edit} />
      ))}
      {lines.map((line, i) => (
        <OutcomeLine key={i} line={line} chip={chip} first={i === 0} />
      ))}
    </Bubble>
  );
}

/** The live edit, stated: *Field: before → after* (panel 7). Only the title is
 *  drawn in full; a long field names itself and the outcome line carries it. */
function EditStatement({ edit }: { edit: Extract<GuideAction, { type: 'edit_item' }> }) {
  const tg = useTranslations('planningWorkspace.guide');
  if (edit.title === undefined) return null;
  return (
    <p className="mt-1.5 text-xs text-(--el-text)" data-testid="guide-edit-statement">
      <span className="font-semibold">{tg('fieldTitle')}: </span>
      {edit.previous.title ? (
        <>
          <span className="rounded-(--radius-kbd) bg-(--el-diff-removed) px-1 text-(--el-text-strong) line-through">
            {edit.previous.title}
          </span>{' '}
          <ArrowRight className="inline size-3 text-(--el-text-secondary)" aria-hidden />{' '}
        </>
      ) : null}
      <span className="rounded-(--radius-kbd) bg-(--el-diff-added) px-1 text-(--el-text-strong)">
        {edit.title}
      </span>
    </p>
  );
}

function OutcomeLine({
  line,
  chip,
  first,
}: {
  line: GuideOutcomeLine;
  chip: WorkItemRefSummaryDto;
  first: boolean;
}) {
  const tg = useTranslations('planningWorkspace.guide.outcome');
  const tf = useTranslations('planningWorkspace.guide.field');
  const chipKey = chip.accessible ? chip.identifier : chip.id;
  const renderChip = () => <WorkItemRefChip summary={chip} fallbackLabel={chipKey} />;
  const Glyph = line.kind === 'ticked' && line.noStatus ? GitPullRequest : OUTCOME_GLYPH[line.kind];
  const n = 'step' in line && line.step !== null ? line.step : '?';

  let body: React.ReactNode;
  switch (line.kind) {
    case 'ticked':
      body = line.temporary
        ? tg('tickedTemp', { n })
        : tg.rich(line.noStatus ? 'tickedNoStatus' : 'ticked', {
            n,
            key: chipKey,
            chip: renderChip,
          });
      break;
    case 'unticked':
      body = line.temporary
        ? tg('untickedTemp', { n })
        : tg.rich('unticked', { n, key: chipKey, chip: renderChip });
      break;
    case 'saved':
      body = tg.rich(line.done > 0 ? 'savedTicked' : 'saved', {
        count: line.count,
        done: line.done,
        key: chipKey,
        chip: renderChip,
      });
      break;
    case 'added':
    case 'changed':
    case 'removed':
    case 'moved':
      body = line.temporary
        ? tg(`${line.kind}Temp`, { n })
        : tg.rich(line.kind, { n, key: chipKey, chip: renderChip });
      break;
    case 'edited':
      body = tg.rich('edited', {
        fields: line.fields.map((f) => tf(f)).join(tf('and')),
        key: chipKey,
        chip: renderChip,
      });
      break;
    case 'commented':
      body = tg.rich('commented', { reason: line.reason, key: chipKey, chip: renderChip });
      break;
    case 'closed':
      body = tg.rich('closed', { key: chipKey, chip: renderChip });
      break;
  }

  return (
    <p
      className={`flex items-start gap-1.5 text-xs text-(--el-text) ${
        first ? 'mt-1.5 border-t border-(--el-border-soft) pt-1.5' : 'mt-0.5'
      }`}
      data-testid="guide-outcome"
      data-outcome={line.kind}
    >
      <Glyph className="mt-px size-3.5 flex-none text-(--el-text-secondary)" aria-hidden="true" />
      <span className="wi-chip-host min-w-0">{body}</span>
    </p>
  );
}
