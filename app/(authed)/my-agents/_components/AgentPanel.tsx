'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Ban,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
  MessageSquare,
  Moon,
  Package,
  Power,
  RotateCw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { chatProfile } from '@/lib/agentInstances/profiles';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { ChatFace, useChatArea } from './AgentChat';
import { AgentPanelHeader, ICON_BUTTON } from './AgentPanelHeader';
import { AgentTerminal } from './AgentTerminal';
import { RefusalBox, type AgentRefusal } from './agentRefusal';
import {
  DOT,
  FACE_ICON,
  STRIP_ICON,
  Strip,
  type Dot,
  type FaceComponent,
  type TabArea,
} from './panelParts';
import { useAgentChat } from './useAgentChat';
import { useAgentTerminal, type TerminalConn, type TerminalSink } from './useAgentTerminal';

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
// THE CHAT TAB (Story MOTIR-6863 · MOTIR-7017) sits beside Terminal in the track,
// built to the approved delta `design/my-agents/my-agents--chat.mock.html`
// (MOTIR-7011): the open tab is kept in the address as `&tab=chat` (written with
// `shallowPush`), an agent still opens on Terminal, aider's tab is disabled from
// `CHAT_PROFILES` without connecting, and the chat's own socket, faces and strips
// live in `AgentChat.tsx` / `useAgentChat.ts`.
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
  initialTab = 'terminal',
}: {
  projectKey: string;
  projectName: string;
  /** The open agent, from the reader's own list; null when that list does not hold it. */
  agent: AgentInstanceListItemDto | null;
  actions: AgentPanelActions;
  /** The tab the address names (`&tab=chat`) for the agent it opened; Terminal otherwise. */
  initialTab?: AgentPanelTab;
}) {
  const t = useTranslations('myAgents.panel');
  const panel = useRef<HTMLDivElement | null>(null);
  useFillViewport(panel);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Esc closes from anywhere in the panel EXCEPT the terminal (there it is the
    // shell's) and the chat's prompt box and popover (there it is theirs).
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-testid="agent-terminal"]')) return;
    if (target?.closest('[data-testid="chat-composer"]')) return;
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
          initialTab={initialTab}
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

/** The panel's two tabs (the chat delta, MOTIR-7011 panel 1). */
export type AgentPanelTab = 'terminal' | 'chat';

/** The query parameter that keeps the open tab in the address (`&tab=chat`). */
export const TAB_PARAM = 'tab';

function tabHref(tab: AgentPanelTab): string {
  const url = new URL(window.location.href);
  if (tab === 'chat') url.searchParams.set(TAB_PARAM, 'chat');
  else url.searchParams.delete(TAB_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

function tabFromAddress(): AgentPanelTab {
  return new URLSearchParams(window.location.search).get(TAB_PARAM) === 'chat'
    ? 'chat'
    : 'terminal';
}

/** The shipped tab's box, shared by both tabs in every state. */
const TAB_BOX =
  'relative inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[0.8125rem] font-medium';
const TAB_ON = `${TAB_BOX} bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)`;
const TAB_OFF = `${TAB_BOX} text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`;

function OpenAgent({
  projectKey,
  projectName,
  agent,
  actions,
  initialTab,
}: {
  projectKey: string;
  projectName: string;
  agent: AgentInstanceListItemDto;
  actions: AgentPanelActions;
  initialTab: AgentPanelTab;
}) {
  const t = useTranslations('myAgents');
  const sink = useRef<TerminalSink | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeRefusal, setWakeRefusal] = useState<AgentRefusal | null>(null);
  const agentRef = useRef(agent);
  useLayoutEffect(() => {
    agentRef.current = agent;
  });

  // Q1/Q8: an unsupported profile's Chat tab is drawn disabled WITHOUT connecting.
  const chatVerdict = chatProfile(agent.profileId);
  const [tab, setTab] = useState<AgentPanelTab>(
    initialTab === 'chat' && chatVerdict.supported ? 'chat' : 'terminal',
  );
  // The chat connects the first time its tab is opened, and stays while the panel does.
  const [chatOpened, setChatOpened] = useState(tab === 'chat');

  const hasTerminal = agent.terminalServer !== 'absent';
  const term = useAgentTerminal({
    projectKey,
    agentId: agent.id,
    enabled: agent.state === 'running' && hasTerminal,
    sink,
  });
  const chat = useAgentChat({
    projectKey,
    agentId: agent.id,
    enabled: agent.state === 'running' && hasTerminal && chatVerdict.supported && chatOpened,
  });
  const conn = term.conn;
  // Did the READER ask for this terminal (or this chat) just now — by opening the
  // panel or the tab, or by pressing Reconnect / Use it here / Try again / Start a
  // new shell? Only then is `not_running` a cue to wake: a tab left open in a
  // background browser tab whose agent hibernated on the idle rule must NOT wake
  // it by itself (Q6).
  const readerAsked = useRef(true);
  const chatReaderAsked = useRef(true);
  useEffect(() => {
    if (conn.kind === 'live') readerAsked.current = false;
  }, [conn.kind]);
  useEffect(() => {
    if (chat.conn.kind === 'live') chatReaderAsked.current = false;
  }, [chat.conn.kind]);

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
  // the reader asked for the terminal or the chat, and otherwise to re-read its state.
  useEffect(() => {
    if (conn.kind !== 'notRunning') return;
    if (readerAsked.current) void wake();
    else actions.onRefresh();
  }, [conn.kind, wake, actions]);
  useEffect(() => {
    if (chat.conn.kind !== 'notRunning') return;
    if (chatReaderAsked.current) void wake();
    else actions.onRefresh();
  }, [chat.conn.kind, wake, actions]);

  // Back / forward move the address; the open tab follows it.
  useEffect(() => {
    const onPop = () => {
      const next = tabFromAddress();
      if (next === 'chat' && !chatProfile(agentRef.current.profileId).supported) return;
      setTab(next);
      if (next === 'chat') setChatOpened(true);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const selectTab = (next: AgentPanelTab) => {
    if (next === tab) return;
    if (next === 'chat' && !chatVerdict.supported) return;
    setTab(next);
    // The chat renders itself; the server answers nothing (CLAUDE.md § URL state).
    shallowPush(tabHref(next));
    if (next !== 'chat') return;
    chatReaderAsked.current = true;
    setChatOpened(true);
    // Opening Chat on a hibernated agent wakes it exactly as the terminal does;
    // the chat ticket follows once it reads running — no second click.
    if (agent.state === 'hibernated' && !waking && !wakeRefusal) void wake();
  };

  const onWake = () => {
    readerAsked.current = true;
    chatReaderAsked.current = true;
    void wake();
  };

  const terminalLifecycle = useLifecycleArea({
    agent,
    waking,
    wakeRefusal,
    onWake,
    Face,
    wakingHint: t('panel.face.wakingHint'),
  });
  const chatLifecycle = useLifecycleArea({
    agent,
    waking,
    wakeRefusal,
    onWake,
    Face: ChatFace,
    wakingHint: t('panel.chat.face.wakingHint'),
  });

  const terminalArea = useTerminalArea({
    agent,
    hasTerminal,
    lifecycle: terminalLifecycle,
    everLive: term.everLive,
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
  const chatArea = useChatArea({
    agent,
    hasServer: hasTerminal,
    lifecycle: chatLifecycle,
    chat,
    onOpenTerminal: () => selectTab('terminal'),
    reconnect: () => {
      chatReaderAsked.current = true;
      chat.reconnect();
    },
  });

  if (conn.kind === 'notAvailable' || chat.conn.kind === 'notAvailable') {
    return <NotAvailable onClose={actions.onClose} />;
  }

  const area = tab === 'chat' ? chatArea : terminalArea;
  const chatTipId = `agent-chat-tip-${agent.id}`;

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
      <div className="flex items-center justify-between gap-3 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2">
        {/* The shipped tab track: Terminal, then Chat (MOTIR-7011 panel 1). */}
        <nav
          aria-label={t('panel.tabs.label')}
          className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
        >
          <button
            type="button"
            aria-current={tab === 'terminal' ? 'page' : undefined}
            onClick={() => selectTab('terminal')}
            className={tab === 'terminal' ? TAB_ON : TAB_OFF}
          >
            <span
              aria-hidden="true"
              className={`inline-flex ${tab === 'terminal' ? 'text-(--el-tabnav-active)' : ''}`}
            >
              <SquareTerminal className="size-3.5" />
            </span>
            {t('panel.tabs.terminal')}
          </button>
          {chatVerdict.supported ? (
            <button
              type="button"
              aria-current={tab === 'chat' ? 'page' : undefined}
              onClick={() => selectTab('chat')}
              className={tab === 'chat' ? TAB_ON : TAB_OFF}
            >
              <span
                aria-hidden="true"
                className={`inline-flex ${tab === 'chat' ? 'text-(--el-tabnav-active)' : ''}`}
              >
                <MessageSquare className="size-3.5" />
              </span>
              {t('panel.tabs.chat')}
            </button>
          ) : (
            // Q1 (aider): disabled, still read — secondary ink, never faint — with
            // the reason on hover AND keyboard focus, tied by aria-describedby.
            <span
              role="button"
              tabIndex={0}
              aria-disabled="true"
              aria-describedby={chatTipId}
              data-testid="agent-chat-tab-disabled"
              className={`group ${TAB_BOX} cursor-not-allowed text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`}
            >
              <Ban aria-hidden="true" className="size-3.5" />
              {t('panel.tabs.chat')}
              <span
                role="tooltip"
                id={chatTipId}
                className="absolute top-[calc(100%+6px)] left-0 z-20 hidden w-[260px] rounded-(--radius-control) bg-(--el-tooltip-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs leading-normal font-normal whitespace-normal text-(--el-tooltip-text) shadow-(--shadow-elevated) group-hover:block group-focus-visible:block"
              >
                {t('panel.chat.unsupported')}
              </span>
            </span>
          )}
        </nav>
        <span
          data-testid="agent-conn"
          className="inline-flex items-center gap-1.5 text-xs text-(--el-text-secondary)"
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${DOT[area.dot]}`} />
          {area.word}
        </span>
      </div>
      {area.strip}
      {/* The terminal stays mounted under the chat, so its screen and socket survive a tab switch. */}
      <div className={`min-h-0 flex-1 flex-col ${tab === 'terminal' ? 'flex' : 'hidden'}`}>
        {terminalArea.body}
      </div>
      {chatOpened ? (
        <div
          data-testid="agent-chat-tab"
          className={`min-h-0 flex-1 flex-col ${tab === 'chat' ? 'flex' : 'hidden'}`}
        >
          {chatArea.body}
        </div>
      ) : null}
    </>
  );
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

/**
 * The agent's lifecycle, in either tab's faces (panel 4): every state but
 * `running` is a face, whichever tab is open. Null when the agent runs.
 */
function useLifecycleArea({
  agent,
  waking,
  wakeRefusal,
  onWake,
  Face: FaceC,
  wakingHint,
}: {
  agent: AgentInstanceListItemDto;
  waking: boolean;
  wakeRefusal: AgentRefusal | null;
  onWake: () => void;
  Face: FaceComponent;
  wakingHint: string;
}): TabArea | null {
  const t = useTranslations('myAgents');
  const wakeButton = (
    <Button size="sm" leftIcon={<Power aria-hidden="true" />} onClick={onWake} loading={waking}>
      {t('panel.wake')}
    </Button>
  );
  const closed = { word: t('panel.conn.closed'), dot: 'ended' as Dot, strip: null };
  const wakingFace = (
    <FaceC
      icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
      title={t('progress.waking')}
    >
      <span>{wakingHint}</span>
    </FaceC>
  );
  const refused = (refusal: AgentRefusal) => (
    <FaceC>
      <div className="max-w-[28rem] text-left">
        <RefusalBox refusal={refusal} />
      </div>
      {wakeButton}
    </FaceC>
  );

  switch (agent.state) {
    case 'starting':
      return {
        word: t('panel.conn.waiting'),
        dot: 'idle',
        strip: null,
        body: (
          <FaceC
            icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.starting')}
          >
            <span>{t('panel.face.startingHint')}</span>
          </FaceC>
        ),
      };
    case 'waking':
      return { word: t('panel.conn.waiting'), dot: 'busy', strip: null, body: wakingFace };
    case 'hibernating':
      return {
        ...closed,
        body: (
          <FaceC
            icon={<Moon className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.hibernating')}
          >
            <span>{t('panel.face.hibernatingHint')}</span>
          </FaceC>
        ),
      };
    case 'deleting':
      return {
        ...closed,
        body: (
          <FaceC
            icon={<Trash2 className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.deleting')}
          >
            <span>{t('panel.face.deletingHint')}</span>
          </FaceC>
        ),
      };
    case 'hibernated': {
      if (wakeRefusal) return { ...closed, body: refused(wakeRefusal) };
      // The wake the open asked for is in flight: its face is waking's.
      if (waking)
        return { word: t('panel.conn.waiting'), dot: 'busy', strip: null, body: wakingFace };
      return {
        ...closed,
        body: (
          <FaceC
            icon={<Moon className={FACE_ICON} aria-hidden="true" />}
            title={t('panel.face.hibernatedTitle', { name: agent.name })}
          >
            {agent.stopReason ? <span>{t(`stop.${agent.stopReason}`)}</span> : null}
            <span>{t('panel.face.kept')}</span>
            {wakeButton}
          </FaceC>
        ),
      };
    }
    case 'failed': {
      if (wakeRefusal) return { ...closed, body: refused(wakeRefusal) };
      return {
        ...closed,
        body: (
          <FaceC icon={<CircleAlert className={FACE_ICON} aria-hidden="true" />}>
            {agent.failureReason ? (
              <span className="text-[0.8125rem] text-(--el-danger-on-surface)">
                {agent.failureReason}
              </span>
            ) : null}
            <span>{t('failedWayOut')}</span>
            {wakeButton}
          </FaceC>
        ),
      };
    }
    case 'running':
      return null;
  }
  return null;
}

/** Decide the connection word, the strip and the terminal area from ONE state. */
function useTerminalArea({
  agent,
  hasTerminal,
  lifecycle,
  everLive,
  reconnect,
  newShell,
  term,
  sink,
}: {
  agent: AgentInstanceListItemDto;
  hasTerminal: boolean;
  lifecycle: TabArea | null;
  everLive: boolean;
  reconnect: () => void;
  newShell: () => void;
  term: ReturnType<typeof useAgentTerminal>;
  sink: React.RefObject<TerminalSink | null>;
}): TabArea {
  const t = useTranslations('myAgents');
  const conn: TerminalConn = term.conn;
  const stripIcon = STRIP_ICON;
  if (lifecycle) return lifecycle;

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
