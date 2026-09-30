'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  FilePen,
  FileText,
  LoaderCircle,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { diffStats, lineCount, type ToolCallEvent, type ToolResultEvent } from './transcriptModel';

// ONE TOOL CALL, ONE ROW (Story MOTIR-6863 · MOTIR-7017;
// `design/my-agents/design-notes.md` § the Chat tab, panel 3). Collapsed by
// default — a failure too; the head is a disclosure button. The body is the
// diff or the output AS TEXT: nothing a tool printed is ever parsed as markup.
// A long body is clipped to its first lines, with an expand.

/** Lines drawn before the body is clipped behind its expand. */
export const TOOL_BODY_CLIP_LINES = 200;

const GLYPH = {
  read: FileText,
  edit: FilePen,
  command: SquareTerminal,
  other: Wrench,
} as const;

export function ChatToolCallRow({
  call,
  result,
  running,
  agentName,
}: {
  call: ToolCallEvent;
  result: ToolResultEvent | null;
  /** Its turn is still running (a row with no result yet reads Running…). */
  running: boolean;
  /** The coding agent's display name (the path-only edit note names it). */
  agentName: string;
}) {
  const t = useTranslations('myAgents.panel.chat.tool');
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const Glyph = GLYPH[call.kind];
  const failed = result !== null && !result.ok;

  const verb =
    call.kind === 'other' ? call.name || call.title : t(call.kind as 'read' | 'edit' | 'command');
  const arg =
    call.kind === 'command'
      ? (call.command ?? call.title)
      : call.kind === 'other'
        ? call.name
          ? call.title
          : ''
        : (call.path ?? call.title);

  let state: React.ReactNode = null;
  if (failed) {
    state = (
      <>
        <CircleX aria-hidden="true" className="size-3.5" />
        {result.exitCode !== undefined
          ? `${t('failed')} · ${t('exit', { code: result.exitCode })}`
          : t('failed')}
      </>
    );
  } else if (result === null) {
    if (running) {
      state = (
        <>
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          {t('running')}
        </>
      );
    }
  } else if (call.kind === 'read' && result.output !== undefined) {
    state = t('lines', { count: lineCount(result.output) });
  } else if (call.kind === 'command' && result.exitCode !== undefined) {
    state = t('exit', { code: result.exitCode });
  }
  if (call.kind === 'edit' && call.diff !== undefined && !failed) {
    const { added, removed } = diffStats(call.diff);
    state = `+${added} −${removed}`;
  }

  return (
    <div
      data-testid="chat-tool-row"
      data-kind={call.kind}
      data-failed={failed ? 'true' : undefined}
      className={`overflow-hidden rounded-(--radius-control) border bg-(--el-card) ${
        failed ? 'border-(--el-danger)' : 'border-(--el-border)'
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${verb} ${arg}`.trim() + ` — ${open ? t('hide') : t('show')}`}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-(--height-control) w-full items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[0.8125rem] hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Glyph aria-hidden="true" className="size-3.5 flex-none text-(--el-text-secondary)" />
        <span className="flex-none font-medium text-(--el-text)">{verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-(--el-text-secondary)">
          {arg}
        </span>
        {state ? (
          <span
            className={`inline-flex flex-none items-center gap-1 text-xs ${
              failed ? 'font-medium text-(--el-danger-on-surface)' : 'text-(--el-text-secondary)'
            }`}
          >
            {state}
          </span>
        ) : null}
        <span aria-hidden="true" className="inline-flex flex-none text-(--el-text-secondary)">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>
      {open ? (
        <div id={bodyId} data-testid="chat-tool-body">
          <ToolBody call={call} result={result} agentName={agentName} />
        </div>
      ) : null}
    </div>
  );
}

function ToolBody({
  call,
  result,
  agentName,
}: {
  call: ToolCallEvent;
  result: ToolResultEvent | null;
  agentName: string;
}) {
  const t = useTranslations('myAgents.panel.chat.tool');
  const clippedNote = result?.truncated ? (
    <p className="m-0 flex items-center gap-1.5 border-t border-(--el-border-soft) bg-(--el-card) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-text-secondary)">
      <TriangleAlert aria-hidden="true" className="size-3 flex-none" />
      {t('truncated')}
    </p>
  ) : null;

  if (call.kind === 'edit' && !(result && !result.ok)) {
    if (call.diff === undefined) {
      return (
        <Code>
          <p className="m-0 font-sans">{t('noDiff', { agent: agentName })}</p>
        </Code>
      );
    }
    return (
      <Code>
        <ClippedLines text={call.diff} diff />
      </Code>
    );
  }
  const output = result?.output;
  return (
    <>
      {clippedNote}
      <Code>
        {output && output.length > 0 ? (
          <ClippedLines text={output} />
        ) : (
          <p className="m-0 font-sans">{t('noOutput')}</p>
        )}
      </Code>
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-(--el-border-soft) bg-(--el-code-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs leading-[1.55] text-(--el-code-text)">
      {children}
    </div>
  );
}

/** The text as text — React escapes it; a diff's lines take their added/removed ground. */
function ClippedLines({ text, diff = false }: { text: string; diff?: boolean }) {
  const t = useTranslations('myAgents.panel.chat.tool');
  const [all, setAll] = useState(false);
  const lines = text.replace(/\n$/, '').split('\n');
  const shown = all ? lines : lines.slice(0, TOOL_BODY_CLIP_LINES);
  return (
    <>
      <pre className="m-0 font-[inherit] break-all whitespace-pre-wrap">
        {diff
          ? shown.map((line, i) => (
              <span key={i} className={`block ${diffLineClass(line)}`}>
                {line.length > 0 ? line : ' '}
              </span>
            ))
          : shown.join('\n')}
      </pre>
      {shown.length < lines.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs font-medium text-(--el-link) underline hover:bg-(--el-surface-soft)"
        >
          {t('showAll', { count: lines.length })}
        </button>
      ) : null}
    </>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-(--el-text-secondary)';
  if (line.startsWith('@@')) return 'text-(--el-text-secondary)';
  if (line.startsWith('+')) return 'bg-(--el-diff-added) text-(--el-text-strong)';
  if (line.startsWith('-')) return 'bg-(--el-diff-removed) text-(--el-text-strong)';
  return '';
}
