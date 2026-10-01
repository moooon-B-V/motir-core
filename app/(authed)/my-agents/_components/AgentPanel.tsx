'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Eye,
  LoaderCircle,
  Moon,
  Package,
  Power,
  RotateCw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import { AgentPanelHeader, ICON_BUTTON } from './AgentPanelHeader';
import { itemHref } from './AgentRunLine';
import { AgentTerminal } from './AgentTerminal';
import { RefusalBox, type AgentRefusal } from './agentRefusal';
import { useAgentTerminal, type TerminalConn, type TerminalSink } from './useAgentTerminal';
import { useRunSessionWatch } from './useRunSessionWatch';

// THE AGENT PANEL (Story MOTIR-6861 · MOTIR-6941) — one of the reader's own agents,
// opened in the right half of My agents beside the list. Built to the approved
// `design/my-agents/my-agents--panel.mock.html` (MOTIR-6937) and its section of
// `design/my-agents/design-notes.md`:
//
//   panel 2  the header (AgentPanelHeader)
//   panel 3  sign-in status, pushed by the terminal server — none before it connects
//   panel 4  every lifecycle value as the terminal area's words; opening a
//            hibernated agent WAKES it and connects when it runs, no second click
//   panel 5  the terminal tab: connecting, live, reconnecting, lost, exited
//   panel 6  the refusals in words — and never another person's agent
//   panel 7  the narrow width (the room hides the list; the header's crumb returns)
//
// THE AGENT'S LIVE RUN (Story MOTIR-6864 · MOTIR-7029, `my-agents--run.mock.html`):
//   panel 1  the run line (the header), and the run's session offered beside the
//            developer's own shell in a `Segmented` at the head of the Terminal
//            tab — listed by the terminal server on the shell's own socket, and
//            watched over a SECOND socket through the same ticket route and relay
//            (one connection answers one session); watch-only, with its sky strip
//   panel 2  Hibernate / Delete off during the run (the header), and the server's
//            refusal shown in the panel's refusal box when pressed from elsewhere
//   panel 3  the end, from either direction: the session exits (the watch shows its
//            last screen, dimmed, under the ended strip, and the list re-reads) or
//            the record closes (the next read turns the run line to "Last run")
//   panel 4  the narrow width: the switch fills the width and drops its hint
//
// ⚠️ THE SERVER DECIDES WHO MAY OPEN AN AGENT. The panel is handed the row from
// the reader's own list (the server's answer), or null when the address names an
// agent that list does not hold; the relay's 4403 lands on the same face. It
// never asks for, and never shows, anything about an agent that is not theirs.

/** The panel fills down to the viewport's bottom edge, but never below this. */
const MIN_PANEL_PX = 420;
/** Room left under the panel so its border is not flush with the window edge. */
const PANEL_BOTTOM_GAP_PX = 24;

export interface AgentPanelActions {
  onClose: () => void;
  onHibernate: (agent: AgentInstanceListItemDto) => void;
  onDelete: (agent: AgentInstanceListItemDto) => void;
  /** Call the Wake route and re-read the list; the refusal to show, or null. */
  onWake: (agent: AgentInstanceListItemDto) => Promise<AgentRefusal | null>;
  /** Re-read the list (the agent's state moved under the panel). */
  onRefresh: () => void;
}

export function AgentPanel({
  projectKey,
  projectName,
  agent,
  actions,
  refusal = null,
}: {
  projectKey: string;
  projectName: string;
  /** The open agent, from the reader's own list; null when that list does not hold it. */
  agent: AgentInstanceListItemDto | null;
  actions: AgentPanelActions;
  /** A Hibernate / Delete refused for THIS agent (MOTIR-7029 panel 2), in the page's box. */
  refusal?: AgentRefusal | null;
}) {
  const t = useTranslations('myAgents.panel');
  const panel = useRef<HTMLDivElement | null>(null);
  useFillViewport(panel);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Esc closes from anywhere in the panel EXCEPT the terminal: there it is the shell's.
    if (event.key !== 'Escape') return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-testid="agent-terminal"]')) return;
    actions.onClose();
  };

  return (
    <section
      ref={panel}
      aria-label={t('label')}
      onKeyDown={onKeyDown}
      data-testid="agent-panel"
      className={`flex min-w-0 flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card) ${
        agent?.state === 'deleting' ? 'opacity-55' : ''
      }`}
    >
      {agent ? (
        <OpenAgent
          key={agent.id}
          projectKey={projectKey}
          projectName={projectName}
          agent={agent}
          actions={actions}
          refusal={refusal}
        />
      ) : (
        <NotAvailable onClose={actions.onClose} />
      )}
    </section>
  );
}

/** Size the panel from its own top edge down to the viewport's bottom (panel 5: the page never scrolls to reach the terminal's last line). */
function useFillViewport(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(MIN_PANEL_PX, window.innerHeight - top - PANEL_BOTTOM_GAP_PX);
      el.style.height = `${height}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ref]);
}

/** Panel 6: one answer for "not yours" and "not found", on purpose — nothing about the agent. */
function NotAvailable({ onClose }: { onClose: () => void }) {
  const t = useTranslations('myAgents.panel');
  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-(--el-border-soft) p-(--spacing-card-padding)">
        <h2 className="m-0 font-serif text-lg font-semibold text-(--el-text)">
          {t('unavailable.title')}
        </h2>
        <button
          type="button"
          aria-label={t('closeUnavailable')}
          onClick={onClose}
          className={ICON_BUTTON}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div
        data-testid="agent-unavailable"
        className="flex flex-col gap-3 p-(--spacing-card-padding) text-sm text-(--el-text)"
      >
        <CircleHelp className="size-7 text-(--el-text-secondary)" aria-hidden="true" />
        <p className="m-0">{t('unavailable.body')}</p>
        <p className="m-0">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<ArrowLeft aria-hidden="true" />}
            onClick={onClose}
          >
            {t('unavailable.back')}
          </Button>
        </p>
      </div>
    </>
  );
}

type Dot = 'idle' | 'busy' | 'live' | 'lost' | 'ended';
const DOT: Record<Dot, string> = {
  idle: 'bg-(--el-status-todo)',
  busy: 'bg-(--el-status-in-progress)',
  live: 'bg-(--el-status-done)',
  lost: 'bg-(--el-danger)',
  ended: 'bg-(--el-status-cancelled)',
};

function OpenAgent({
  projectKey,
  projectName,
  agent,
  actions,
  refusal,
}: {
  projectKey: string;
  projectName: string;
  agent: AgentInstanceListItemDto;
  actions: AgentPanelActions;
  refusal: AgentRefusal | null;
}) {
  const t = useTranslations('myAgents');
  const sink = useRef<TerminalSink | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeRefusal, setWakeRefusal] = useState<AgentRefusal | null>(null);
  const agentRef = useRef(agent);
  useLayoutEffect(() => {
    agentRef.current = agent;
  });

  const hasTerminal = agent.terminalServer !== 'absent';
  const term = useAgentTerminal({
    projectKey,
    agentId: agent.id,
    enabled: agent.state === 'running' && hasTerminal,
    sink,
  });
  const conn = term.conn;
  // Did the READER ask for this terminal just now — by opening the panel, or by
  // pressing Reconnect / Use it here / Try again / Start a new shell? Only then
  // is `not_running` a cue to wake: a terminal left open in a background tab
  // whose agent hibernated on the idle rule must NOT wake it by itself (Q6).
  const readerAsked = useRef(true);
  useEffect(() => {
    if (conn.kind === 'live') readerAsked.current = false;
  }, [conn.kind]);

  const wake = useCallback(async () => {
    setWakeRefusal(null);
    setWaking(true);
    const refusal = await actions.onWake(agentRef.current);
    setWaking(false);
    setWakeRefusal(refusal);
  }, [actions]);

  // Q6: opening a hibernated agent wakes it — no second click. Only on OPEN: an
  // agent that stops while the panel is open rests on the hibernated face.
  const openedWith = useRef(agent.state);
  useEffect(() => {
    if (openedWith.current === 'hibernated') void wake();
    // Once per open (the panel is keyed by the agent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `not_running` / 4409 carry no words: they are the cue to wake the agent when
  // the reader asked for the terminal, and otherwise to re-read its state.
  useEffect(() => {
    if (conn.kind !== 'notRunning') return;
    if (readerAsked.current) void wake();
    else actions.onRefresh();
  }, [conn.kind, wake, actions]);

  const area = useTerminalArea({
    agent,
    hasTerminal,
    waking,
    wakeRefusal,
    everLive: term.everLive,
    onWake: () => {
      readerAsked.current = true;
      void wake();
    },
    reconnect: () => {
      readerAsked.current = true;
      term.reconnect();
    },
    newShell: () => {
      readerAsked.current = true;
      term.newShell();
    },
    term,
    sink,
  });

  const run = useRunView({ projectKey, agent, term, onRefresh: actions.onRefresh });

  if (conn.kind === 'notAvailable') return <NotAvailable onClose={actions.onClose} />;

  return (
    <>
      <AgentPanelHeader
        agent={agent}
        projectName={projectName}
        signIn={term.signIn}
        onClose={actions.onClose}
        onHibernate={() => actions.onHibernate(agent)}
        onDelete={() => actions.onDelete(agent)}
      />
      {refusal ? (
        <div className="border-b border-(--el-border-soft) p-(--spacing-card-padding)">
          <RefusalBox refusal={refusal} />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2">
        {/* The shipped tab track, one tab today; the chat story adds Chat beside it. */}
        <nav
          aria-label={t('panel.tabs.label')}
          className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
        >
          <span
            aria-current="page"
            className="inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) bg-(--el-page-bg) px-(--spacing-control-x) text-[0.8125rem] font-medium text-(--el-text-strong) shadow-(--shadow-subtle)"
          >
            <span aria-hidden="true" className="inline-flex text-(--el-tabnav-active)">
              <SquareTerminal className="size-3.5" />
            </span>
            {t('panel.tabs.terminal')}
          </span>
        </nav>
        <span
          data-testid="agent-conn"
          className="inline-flex items-center gap-1.5 text-xs text-(--el-text-secondary)"
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${DOT[area.dot]}`} />
          {area.word}
        </span>
      </div>
      {run.bar}
      {run.watching ? run.strip : area.strip}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The shell stays mounted while the run is watched, so switching back is instant. */}
        <div className={run.watching ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>{area.body}</div>
        {run.body}
      </div>
    </>
  );
}

type RunView =
  | { kind: 'shell' }
  | { kind: 'run'; session: string; runId: string; workItemKey: string | null };

/**
 * THE RUN'S SESSION, beside the developer's shell (MOTIR-7029 panels 1, 3, 4).
 *
 * The switch shows while the shell's socket lists a run session AND the record
 * says that run is working in this agent — the panel matches the listing's run id
 * to the run line's. A listing the record has not caught up with asks the list to
 * re-read (the run just started); a listing that drops its run, or a watched
 * session that exits, does too (the run just ended) — the end arrives from both
 * directions, and either one turns the header without a reload.
 */
function useRunView({
  projectKey,
  agent,
  term,
  onRefresh,
}: {
  projectKey: string;
  agent: AgentInstanceListItemDto;
  term: ReturnType<typeof useAgentTerminal>;
  onRefresh: () => void;
}): { watching: boolean; bar: ReactNode; strip: ReactNode; body: ReactNode } {
  const t = useTranslations('myAgents');
  const sink = useRef<TerminalSink | null>(null);
  const [view, setView] = useState<RunView>({ kind: 'shell' });
  const listed = term.sessions.find((s) => s.kind === 'run') ?? null;
  const activeRun = agent.activeRun;
  const offered = listed && activeRun && listed.runId === activeRun.id ? listed : null;
  const watch = useRunSessionWatch({
    projectKey,
    agentId: agent.id,
    session: view.kind === 'run' ? view.session : null,
    sink,
  });

  // The listing and the record disagree: re-read the record, once per change.
  const listedRun = listed?.runId ?? null;
  const seenListed = useRef<string | null>(null);
  useEffect(() => {
    const previous = seenListed.current;
    seenListed.current = listedRun;
    if (listedRun !== null && listedRun !== activeRun?.id) onRefresh();
    else if (listedRun === null && previous !== null) onRefresh();
  }, [listedRun, activeRun?.id, onRefresh]);

  // The watched session exited (or the server no longer knows it) — the run
  // ended: re-read the record for how it ended.
  const watchEnded = view.kind === 'run' && watch.conn.kind === 'ended';
  useEffect(() => {
    if (watchEnded) onRefresh();
  }, [watchEnded, onRefresh]);

  // A watch that could not be opened at all hands the reader back their shell.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (watch.conn.kind === 'lost') setView({ kind: 'shell' });
  }, [watch.conn.kind]);

  const toShell = () => setView({ kind: 'shell' });
  const watching = view.kind === 'run';
  const stripIcon = 'size-4 flex-none';

  // Panel 3: once the watched session has ended its segment has left the switch,
  // and with one session left the switch goes — the ended strip holds the way back.
  const bar =
    offered || (watching && !watchEnded) ? (
      <div className="flex items-center gap-3 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2">
        <Segmented
          label={t('panel.run.sessions.label')}
          value={watching ? 'run' : 'shell'}
          fill
          className="@5xl:inline-flex @5xl:w-auto @5xl:[&>button]:flex-none @5xl:[&>button]:px-(--spacing-control-x)"
          onChange={(next) => {
            if (next === 'shell') toShell();
            else if (offered) {
              setView({
                kind: 'run',
                session: offered.session,
                runId: offered.runId ?? '',
                workItemKey: activeRun?.workItemKey ?? null,
              });
            }
          }}
          options={[
            {
              value: 'shell',
              label: t('panel.run.sessions.shell'),
              icon: <SquareTerminal className="size-3.5" />,
            },
            {
              value: 'run',
              label: t('panel.run.sessions.run', {
                key: (watching ? view.workItemKey : activeRun?.workItemKey) ?? '',
              }),
              icon: <span className="size-[7px] rounded-full bg-(--el-status-in-progress)" />,
              trailing: <Eye aria-hidden="true" className="size-3.5" />,
            },
          ]}
        />
        <span className="ml-auto hidden text-xs text-(--el-text-secondary) @5xl:inline">
          {t('panel.run.sessions.watchOnly')}
        </span>
      </div>
    ) : null;

  if (view.kind === 'shell') return { watching: false, bar, strip: null, body: null };

  const key = view.workItemKey ?? '';
  let strip: ReactNode;
  if (watchEnded) {
    const last = agent.lastRun?.id === view.runId ? agent.lastRun : null;
    const text = !last
      ? t('panel.conn.ended')
      : last.status === 'succeeded'
        ? t('panel.run.strip.endedSucceeded')
        : t('panel.run.strip.endedFailed');
    strip = (
      <Strip
        tone="muted"
        icon={
          last?.status === 'succeeded' ? (
            <CircleCheck className={stripIcon} aria-hidden="true" />
          ) : (
            <SquareTerminal className={stripIcon} aria-hidden="true" />
          )
        }
        text={text}
        action={
          <Button
            variant="secondary"
            size="sm"
            className="flex-none bg-(--el-card)"
            leftIcon={<SquareTerminal aria-hidden="true" />}
            onClick={toShell}
          >
            {t('panel.run.backToShell')}
          </Button>
        }
      />
    );
  } else if (watch.conn.kind === 'takenOver') {
    strip = (
      <Strip
        tone="muted"
        icon={<Eye className={stripIcon} aria-hidden="true" />}
        text={t('panel.strip.takenOver')}
        action={
          <Button
            variant="secondary"
            size="sm"
            className="flex-none bg-(--el-card)"
            leftIcon={<RotateCw aria-hidden="true" />}
            onClick={watch.retake}
          >
            {t('panel.useHere')}
          </Button>
        }
      />
    );
  } else {
    strip = (
      <Strip
        tone="sky"
        icon={<Eye className={stripIcon} aria-hidden="true" />}
        text={t.rich('panel.run.strip.watching', {
          key,
          link: (chunks) =>
            view.workItemKey ? (
              <Link href={itemHref(view.workItemKey)} className="text-(--el-link) underline">
                {chunks}
              </Link>
            ) : (
              chunks
            ),
        })}
      />
    );
  }

  const connecting = watch.conn.kind === 'connecting' || watch.conn.kind === 'idle';
  const body = (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-run-watch">
      <AgentTerminal
        key={view.session}
        sinkRef={sink}
        onData={() => {}}
        onResize={watch.sendResize}
        inputEnabled={false}
        watchOnly
        dimmed={watchEnded || watch.conn.kind === 'takenOver'}
        label={t('panel.run.sessions.run', { key })}
        jumpLabel={t('panel.jumpLatest')}
        sizeLabel={(cols, rows) => t('panel.size', { cols, rows })}
        overlay={
          connecting && !watchEnded ? (
            <Face icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}>
              <span>{t('panel.face.connecting', { name: agent.name })}</span>
            </Face>
          ) : undefined
        }
      />
    </div>
  );
  return { watching: true, bar, strip, body };
}

function Face({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-(--el-code-bg) p-4 text-center text-[0.8125rem] text-(--el-code-text)">
      {icon}
      {title ? <strong className="text-sm">{title}</strong> : null}
      {children}
    </div>
  );
}

const FACE_ICON = 'size-[22px]';

function Strip({
  tone,
  alert,
  icon,
  text,
  action,
}: {
  tone: 'sky' | 'rose' | 'muted';
  alert?: boolean;
  icon: ReactNode;
  text: ReactNode;
  action?: ReactNode;
}) {
  const ground =
    tone === 'sky'
      ? 'bg-(--el-tint-sky)'
      : tone === 'rose'
        ? 'bg-(--el-tint-rose)'
        : 'bg-(--el-muted)';
  return (
    <div
      role={alert ? 'alert' : 'status'}
      className={`flex items-center gap-2 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-(--spacing-control-y) text-[0.8125rem] text-(--el-text-strong) ${ground}`}
    >
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}

/** Decide the connection word, the strip and the terminal area from ONE state. */
function useTerminalArea({
  agent,
  hasTerminal,
  waking,
  wakeRefusal,
  everLive,
  onWake,
  reconnect,
  newShell,
  term,
  sink,
}: {
  agent: AgentInstanceListItemDto;
  hasTerminal: boolean;
  waking: boolean;
  wakeRefusal: AgentRefusal | null;
  everLive: boolean;
  onWake: () => void;
  reconnect: () => void;
  newShell: () => void;
  term: ReturnType<typeof useAgentTerminal>;
  sink: React.RefObject<TerminalSink | null>;
}): { word: string; dot: Dot; strip: ReactNode; body: ReactNode } {
  const t = useTranslations('myAgents');
  const conn: TerminalConn = term.conn;
  const wakeButton = (
    <Button size="sm" leftIcon={<Power aria-hidden="true" />} onClick={onWake} loading={waking}>
      {t('panel.wake')}
    </Button>
  );
  const closed = { word: t('panel.conn.closed'), dot: 'ended' as Dot, strip: null };
  const stripIcon = 'size-4 flex-none';

  switch (agent.state) {
    case 'starting':
      return {
        word: t('panel.conn.waiting'),
        dot: 'idle',
        strip: null,
        body: (
          <Face
            icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.starting')}
          >
            <span>{t('panel.face.startingHint')}</span>
          </Face>
        ),
      };
    case 'waking':
      return {
        word: t('panel.conn.waiting'),
        dot: 'busy',
        strip: null,
        body: <WakingFace />,
      };
    case 'hibernating':
      return {
        ...closed,
        body: (
          <Face
            icon={<Moon className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.hibernating')}
          >
            <span>{t('panel.face.hibernatingHint')}</span>
          </Face>
        ),
      };
    case 'deleting':
      return {
        ...closed,
        body: (
          <Face
            icon={<Trash2 className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.deleting')}
          >
            <span>{t('panel.face.deletingHint')}</span>
          </Face>
        ),
      };
    case 'hibernated': {
      if (wakeRefusal)
        return { ...closed, body: <RefusedWake refusal={wakeRefusal} wake={wakeButton} /> };
      // The wake the open asked for is in flight: its face is waking's.
      if (waking)
        return { word: t('panel.conn.waiting'), dot: 'busy', strip: null, body: <WakingFace /> };
      return {
        ...closed,
        body: (
          <Face
            icon={<Moon className={FACE_ICON} aria-hidden="true" />}
            title={t('panel.face.hibernatedTitle', { name: agent.name })}
          >
            {agent.stopReason ? <span>{t(`stop.${agent.stopReason}`)}</span> : null}
            <span>{t('panel.face.kept')}</span>
            {wakeButton}
          </Face>
        ),
      };
    }
    case 'failed': {
      if (wakeRefusal)
        return { ...closed, body: <RefusedWake refusal={wakeRefusal} wake={wakeButton} /> };
      return {
        ...closed,
        body: (
          <Face icon={<CircleAlert className={FACE_ICON} aria-hidden="true" />}>
            {agent.failureReason ? (
              <span className="text-[0.8125rem] text-(--el-danger-on-surface)">
                {agent.failureReason}
              </span>
            ) : null}
            <span>{t('failedWayOut')}</span>
            {wakeButton}
          </Face>
        ),
      };
    }
    case 'running':
      break;
  }

  // Q8: an image from before the terminal — the agent is fine, it just has no terminal.
  if (!hasTerminal || conn.kind === 'noTerminal') {
    return {
      word: t('panel.conn.unavailable'),
      dot: 'ended',
      strip: null,
      body: (
        <Face
          icon={<Package className={FACE_ICON} aria-hidden="true" />}
          title={t('panel.noTerminal.title')}
        >
          <span className="max-w-[28rem]">{t('panel.noTerminal.body')}</span>
        </Face>
      ),
    };
  }

  let word = t('panel.conn.connecting');
  let dot: Dot = 'busy';
  let strip: ReactNode = null;
  let overlay: ReactNode = null;
  const again = (label: string, onClick: () => void) => (
    <Button
      variant="secondary"
      size="sm"
      className="flex-none bg-(--el-card)"
      leftIcon={<RotateCw aria-hidden="true" />}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  switch (conn.kind) {
    case 'live':
      word = t('panel.conn.live');
      dot = 'live';
      break;
    case 'reconnecting':
      word = t('panel.conn.reconnecting');
      strip = (
        <Strip
          tone="sky"
          icon={<LoaderCircle className={stripIcon} aria-hidden="true" />}
          text={t('panel.strip.reconnecting')}
        />
      );
      break;
    case 'lost':
      word = t('panel.conn.lost');
      dot = 'lost';
      strip = (
        <Strip
          tone="rose"
          alert
          icon={<CircleAlert className={stripIcon} aria-hidden="true" />}
          text={conn.machine ? t('panel.strip.lostMachine') : t('panel.strip.lost')}
          action={again(t('panel.reconnect'), reconnect)}
        />
      );
      break;
    case 'exited':
      word = t('panel.conn.ended');
      dot = 'ended';
      strip = (
        <Strip
          tone="muted"
          icon={<SquareTerminal className={stripIcon} aria-hidden="true" />}
          text={t('panel.strip.exited')}
          action={again(t('panel.newShell'), newShell)}
        />
      );
      break;
    case 'takenOver':
      word = t('panel.conn.ended');
      dot = 'ended';
      strip = (
        <Strip
          tone="muted"
          icon={<SquareTerminal className={stripIcon} aria-hidden="true" />}
          text={t('panel.strip.takenOver')}
          action={again(t('panel.useHere'), reconnect)}
        />
      );
      break;
    case 'sessionLimit':
      word = t('panel.conn.unavailable');
      dot = 'ended';
      overlay = (
        <Face icon={<SquareTerminal className={FACE_ICON} aria-hidden="true" />}>
          <span>{t('panel.sessionLimit', { name: agent.name })}</span>
          {again(t('panel.tryAgain'), reconnect)}
        </Face>
      );
      break;
    default:
      // idle · connecting · notRunning (the wake is under way): the connecting face,
      // over a terminal that has never shown this agent's shell in this panel.
      if (!everLive) {
        overlay = (
          <Face icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}>
            <span>{t('panel.face.connecting', { name: agent.name })}</span>
          </Face>
        );
      }
  }

  const paused = conn.kind === 'reconnecting' || conn.kind === 'lost' || conn.kind === 'takenOver';
  return {
    word,
    dot,
    strip,
    body: (
      <AgentTerminal
        sinkRef={sink}
        onData={term.sendInput}
        onResize={term.sendResize}
        inputEnabled={conn.kind === 'live'}
        dimmed={paused}
        label={t('panel.tabs.terminal')}
        jumpLabel={t('panel.jumpLatest')}
        sizeLabel={(cols, rows) => t('panel.size', { cols, rows })}
        overlay={overlay}
      />
    ),
  };
}

function WakingFace() {
  const t = useTranslations('myAgents');
  return (
    <Face
      icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
      title={t('progress.waking')}
    >
      <span>{t('panel.face.wakingHint')}</span>
    </Face>
  );
}

/** Panel 6: a refused wake lands inside the panel, in the list's own box and copy. */
function RefusedWake({ refusal, wake }: { refusal: AgentRefusal; wake: ReactNode }) {
  return (
    <Face>
      <div className="max-w-[28rem] text-left">
        <RefusalBox refusal={refusal} />
      </div>
      {wake}
    </Face>
  );
}
