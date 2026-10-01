'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  CircleAlert,
  CircleArrowUp,
  LoaderCircle,
  Lock,
  MessageSquare,
  Package,
  RotateCw,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import { ChatPromptBox, type PromptBoxState } from './chat/ChatPromptBox';
import { ChatSessionList } from './chat/ChatSessionList';
import { ChatEmptyFace, ChatTranscript } from './chat/ChatTranscript';
import { FACE_ICON, STRIP_ICON, Strip, type Dot, type TabArea } from './panelParts';
import type { useAgentChat } from './useAgentChat';

// THE CHAT TAB (Story MOTIR-6863 · MOTIR-7017) — a conversation with the agent
// beside its terminal, built to the approved delta
// `design/my-agents/my-agents--chat.mock.html` (MOTIR-7011) and its section of
// `design/my-agents/design-notes.md`, over `docs/decisions/agent-chat.md`:
//
//   panel 1  the tab in the track (AgentPanel), a new chat's face
//   panel 2  the transcript            (chat/ChatTranscript)
//   panel 3  the tool-call rows        (chat/ChatToolCallRow)
//   panel 4  how a turn ends           (chat/ChatTranscript)
//   panel 5  the prompt box, its two refusals (chat/ChatPromptBox, ChatNotice)
//   panel 6  the session list, resume, taken over (chat/ChatSessionList)
//   panel 7  when the agent can't chat — subscription, not signed in, 4411
//   panel 8  waking, connecting, reconnecting, lost
//
// ⚠️ THE CONVERSATION STAYS ON THE PAGE (Q10): component state only — nothing
// here writes browser storage, a Sentry breadcrumb, analytics or the console.

type Chat = ReturnType<typeof useAgentChat>;

/** A face that fills the tab when the agent can't chat, or not yet (panels 7 and 8). */
export function ChatFace({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="chat-face"
      className="flex flex-1 flex-col items-center justify-center gap-2 bg-(--el-card) p-(--spacing-card-padding) text-center text-[0.8125rem] leading-normal text-(--el-text-secondary)"
    >
      {icon ? <span className="inline-flex text-(--el-text-secondary)">{icon}</span> : null}
      {title ? <strong className="text-sm text-(--el-text)">{title}</strong> : null}
      {children}
    </div>
  );
}

/** A refusal or notice directly above the prompt box (panels 5–7). */
function ChatNotice({
  tone,
  alert,
  icon,
  text,
  action,
}: {
  tone: 'peach' | 'rose' | 'muted';
  alert?: boolean;
  icon: ReactNode;
  text: string;
  action?: ReactNode;
}) {
  const ground =
    tone === 'peach'
      ? 'bg-(--el-tint-peach)'
      : tone === 'rose'
        ? 'bg-(--el-tint-rose)'
        : 'bg-(--el-muted)';
  return (
    <div
      role={alert ? 'alert' : 'status'}
      data-testid="chat-notice"
      className={`flex items-center gap-2 border-t border-(--el-border-soft) px-(--spacing-card-padding) py-(--spacing-control-y) text-[0.8125rem] text-(--el-text-strong) ${ground}`}
    >
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}

/**
 * Decide the Chat tab's connection word, its strip and its body from ONE state:
 * the agent's lifecycle first (`lifecycle`, the panel's own faces), then the
 * chat's connection.
 */
export function useChatArea({
  agent,
  hasServer,
  lifecycle,
  chat,
  onOpenTerminal,
  onUpdate,
  reconnect,
}: {
  agent: AgentInstanceListItemDto;
  /** The image serves the in-agent server (the chat rides the terminal's). */
  hasServer: boolean;
  /** The lifecycle face for a non-running agent, or null when it runs. */
  lifecycle: TabArea | null;
  chat: Chat;
  onOpenTerminal: () => void;
  /** Open the Update confirmation — the no-chat-server face's way out (MOTIR-6953). */
  onUpdate: () => void;
  reconnect: () => void;
}): TabArea {
  const t = useTranslations('myAgents.panel');
  const tUpdate = useTranslations('myAgents.update');
  if (lifecycle) return lifecycle;

  const conn = chat.conn;
  // Q8: an image from before the chat — the agent is fine, it just cannot chat.
  if (!hasServer || conn.kind === 'noChatServer') {
    return {
      word: t('conn.unavailable'),
      dot: 'ended',
      strip: null,
      body: (
        <ChatFace
          icon={<Package className={FACE_ICON} aria-hidden="true" />}
          title={t('chat.noServer.title')}
        >
          {agent.update && agent.update !== 'unknown' ? (
            // The way out is the update, where one is offered (as on the terminal's face).
            <>
              <span className="max-w-[30rem]">
                {t('chat.noServer.update', { to: agent.update.version })}
              </span>
              <Button size="sm" leftIcon={<CircleArrowUp aria-hidden="true" />} onClick={onUpdate}>
                {tUpdate('actionTo', { to: agent.update.version })}
              </Button>
            </>
          ) : (
            <span className="max-w-[30rem]">{t('chat.noServer.body')}</span>
          )}
        </ChatFace>
      ),
    };
  }

  const openTerminal = (
    <Button
      variant="secondary"
      size="sm"
      className="flex-none bg-(--el-card)"
      leftIcon={<SquareTerminal aria-hidden="true" />}
      onClick={onOpenTerminal}
    >
      {t('chat.openTerminal')}
    </Button>
  );

  // Q2: Claude Code on a Claude subscription — the server's hello decides. One
  // face, no prompt box; the terminal beside it is untouched.
  if (conn.kind === 'refused') {
    return {
      word: t('conn.live'),
      dot: 'live',
      strip: null,
      body: (
        <ChatFace
          icon={<Lock className={FACE_ICON} aria-hidden="true" />}
          title={conn.reason === 'subscription_signin' ? t('chat.subscription.title') : undefined}
        >
          <span data-testid="chat-refusal" className="max-w-[30rem]">
            {conn.reason === 'subscription_signin'
              ? t('chat.subscription.body')
              : t('chat.unsupported')}
          </span>
          {openTerminal}
        </ChatFace>
      ),
    };
  }

  let word = t('conn.connecting');
  let dot: Dot = 'busy';
  let strip: ReactNode = null;
  const again = (
    <Button
      variant="secondary"
      size="sm"
      className="flex-none bg-(--el-card)"
      leftIcon={<RotateCw aria-hidden="true" />}
      onClick={reconnect}
    >
      {conn.kind === 'takenOver' ? t('useHere') : t('reconnect')}
    </Button>
  );
  switch (conn.kind) {
    case 'live':
      word = t('conn.live');
      dot = 'live';
      break;
    case 'reconnecting':
      word = t('conn.reconnecting');
      strip = (
        <Strip
          tone="sky"
          icon={<LoaderCircle className={STRIP_ICON} aria-hidden="true" />}
          text={t('chat.strip.reconnecting')}
        />
      );
      break;
    case 'lost':
      word = t('conn.lost');
      dot = 'lost';
      strip = (
        <Strip
          tone="rose"
          alert
          icon={<CircleAlert className={STRIP_ICON} aria-hidden="true" />}
          text={conn.machine ? t('strip.lostMachine') : t('chat.strip.lost')}
          action={again}
        />
      );
      break;
    case 'takenOver':
      word = t('conn.ended');
      dot = 'ended';
      break;
    default:
      break;
  }

  // Connecting (idle · connecting · notRunning while the wake is under way):
  // the centred line, over a tab that has never shown this agent's chat.
  if (!chat.everLive && conn.kind !== 'live') {
    return {
      word,
      dot,
      strip,
      body: (
        <ChatFace icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}>
          <span>{t('chat.face.connecting', { name: agent.name })}</span>
        </ChatFace>
      ),
    };
  }

  return {
    word,
    dot,
    strip,
    body: (
      <AgentChat
        agent={agent}
        chat={chat}
        openTerminal={openTerminal}
        takenOverAction={conn.kind === 'takenOver' ? again : null}
      />
    ),
  };
}

function AgentChat({
  agent,
  chat,
  openTerminal,
  takenOverAction,
}: {
  agent: AgentInstanceListItemDto;
  chat: Chat;
  openTerminal: ReactNode;
  takenOverAction: ReactNode;
}) {
  const t = useTranslations('myAgents.panel.chat');
  const [listOpen, setListOpen] = useState(false);
  const agentName = agent.profileName;
  const live = chat.conn.kind === 'live';
  const paused =
    chat.conn.kind === 'reconnecting' ||
    chat.conn.kind === 'lost' ||
    chat.conn.kind === 'takenOver';
  const running = chat.transcript.runningTurn !== null;

  const boxState: PromptBoxState = !live
    ? 'disabled'
    : chat.pending !== null
      ? 'sending'
      : running
        ? 'running'
        : 'ready';

  const firstPrompt = chat.transcript.rows.find((r) => r.type === 'user');
  const title =
    chat.session.title ??
    (firstPrompt?.type === 'user' ? firstPrompt.text : (chat.pending ?? t('newChat')));

  let notice: ReactNode = null;
  if (takenOverAction) {
    notice = (
      <ChatNotice
        tone="muted"
        icon={<MessageSquare className={STRIP_ICON} aria-hidden="true" />}
        text={t('notice.takenOver')}
        action={takenOverAction}
      />
    );
  } else if (chat.notice === 'notSignedIn' || chat.signIn === 'signed_out') {
    notice = (
      <ChatNotice
        tone="peach"
        alert
        icon={<TriangleAlert className={STRIP_ICON} aria-hidden="true" />}
        text={t('notice.notSignedIn', { agent: agentName })}
        action={openTerminal}
      />
    );
  } else if (chat.notice === 'turnRunning') {
    notice = (
      <ChatNotice
        tone="peach"
        icon={<TriangleAlert className={STRIP_ICON} aria-hidden="true" />}
        text={t('notice.turnRunning', { name: agent.name })}
      />
    );
  } else if (chat.notice === 'tooLarge') {
    notice = (
      <ChatNotice
        tone="rose"
        alert
        icon={<CircleAlert className={STRIP_ICON} aria-hidden="true" />}
        text={t('notice.tooLarge', { agent: agentName })}
      />
    );
  }

  return (
    <div data-testid="agent-chat" className="flex min-h-0 flex-1 flex-col bg-(--el-card)">
      <div className="@container flex items-center justify-between gap-3 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2">
        <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] font-medium text-(--el-text)">
          <span data-testid="chat-title" className="min-w-0 truncate">
            {title}
          </span>
          {chat.session.resumed ? (
            <span className="flex-none rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
              {t('resumed')}
            </span>
          ) : null}
        </span>
        <ChatSessionList
          open={listOpen}
          onOpenChange={(next) => {
            setListOpen(next);
            if (next) chat.listSessions();
          }}
          sessions={chat.sessions}
          currentId={chat.session.id}
          agentName={agentName}
          machineName={agent.name}
          disabled={!live}
          onChoose={(s) => chat.openSession(s)}
          onNewChat={() => chat.openSession(null)}
        />
      </div>
      <ChatTranscript
        transcript={chat.transcript}
        pendingPrompt={chat.pending}
        agentName={agentName}
        dimmed={paused}
        historyNote={chat.historyNote}
        emptyFace={<ChatEmptyFace agentName={agentName} machineName={agent.name} />}
      />
      {notice}
      <ChatPromptBox
        agentName={agentName}
        value={chat.draft}
        onChange={chat.setDraft}
        state={boxState}
        onSend={() => void chat.send()}
        onStop={chat.stop}
      />
    </div>
  );
}
