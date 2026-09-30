'use client';

import type { ReactNode } from 'react';

// Pieces the agent panel's two tabs share (Story MOTIR-6861 · MOTIR-6941, and the
// Chat tab, MOTIR-7017): the connection dot, the strip under the tab track, and
// the shape every tab's area takes. The strips are the approved panel design's
// (`design/my-agents/my-agents--panel.mock.html`, panel 5), which the chat delta
// reuses reworded (`my-agents--chat.mock.html`, panel 8).

export type Dot = 'idle' | 'busy' | 'live' | 'lost' | 'ended';

export const DOT: Record<Dot, string> = {
  idle: 'bg-(--el-status-todo)',
  busy: 'bg-(--el-status-in-progress)',
  live: 'bg-(--el-status-done)',
  lost: 'bg-(--el-danger)',
  ended: 'bg-(--el-status-cancelled)',
};

/** What a tab contributes: the connection word and dot, a strip, and its body. */
export interface TabArea {
  word: string;
  dot: Dot;
  strip: ReactNode;
  body: ReactNode;
}

export const FACE_ICON = 'size-[22px]';
export const STRIP_ICON = 'size-4 flex-none';

/** A face's shape — the terminal's (on the code ground) and the chat's (on the card). */
export type FaceComponent = (props: {
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
}) => ReactNode;

export function Strip({
  tone,
  alert,
  icon,
  text,
  action,
}: {
  tone: 'sky' | 'rose' | 'muted';
  alert?: boolean;
  icon: ReactNode;
  text: string;
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
