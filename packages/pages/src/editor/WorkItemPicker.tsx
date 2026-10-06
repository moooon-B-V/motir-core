import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Loader2, RotateCw, TriangleAlert } from 'lucide-react';
import type { PageEditorMessages } from './messages';
import {
  MENTION_MIN_QUERY_LENGTH,
  MENTION_SEARCH_DEBOUNCE_MS,
  PICKER_KEY_EVENT,
  type WorkItemCandidate,
} from './workItemMention';

// The page's WORK-ITEM PICKER (Story MOTIR-5747 · MOTIR-7574) — panel 3 of
// `design/pages/page--work-item-mention.mock.html`, every state:
//
//   1 · a query under two characters (a bare `@` included) → the hint;
//   2 · loading, from the keystroke through the 250 ms debounce to the answer;
//   3 · results, the first row active;
//   4 · no results;
//   5 · keyboard focus — ↑/↓ move the active row (wrapping), Enter inserts, and
//       Escape (the suggestion's own) closes; focus stays in the editor, so the
//       active row is `aria-activedescendant` + `aria-selected`;
//   6 · search failed → an alert line and ONE option, Try again, active, so
//       Enter retries.
//
// It is the app's `MentionList` (`components/ui/markdownEditorMentions.tsx`)
// mounted WORK ITEMS ONLY — the same listbox, section label and state rows,
// restated by class because the package may not import the app. The ROW is the
// app's: `renderRow` is the host's `MentionList` work-item row.

export interface WorkItemPickerProps<C extends WorkItemCandidate> {
  /** The text after the `@`. */
  query: string;
  search: (query: string) => Promise<C[]>;
  renderRow: (candidate: C, active: boolean) => ReactNode;
  onPick: (candidate: C) => void;
  /** The listbox's name — `pages.editor.toolbar.workItemLabel`. */
  label: string;
  messages: PageEditorMessages['mention'];
}

type Result<C> = { key: string; ok: true; items: C[] } | { key: string; ok: false };

const ROW =
  'flex min-w-70 cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text)';
const HINT =
  'flex items-center justify-center gap-1.5 px-(--spacing-control-x) py-2 text-center text-xs text-(--el-text-secondary)';

/** The picker; generic over the host's candidate type. */
export function WorkItemPicker<C extends WorkItemCandidate>({
  query,
  search,
  renderRow,
  onPick,
  label,
  messages,
}: WorkItemPickerProps<C>) {
  const idBase = useId();
  const trimmed = query.trim();
  const tooShort = trimmed.length < MENTION_MIN_QUERY_LENGTH;
  // A retry is a new request for the same query.
  const [attempt, setAttempt] = useState(0);
  const requestKey = tooShort ? null : `${attempt}\u0000${trimmed}`;
  const [result, setResult] = useState<Result<C> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // The search closure may change identity on every render; read it through a
  // ref so it is not a dependency of the request.
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  useEffect(() => {
    if (requestKey === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchRef.current(trimmed).then(
        (items) => {
          if (!cancelled) setResult({ key: requestKey, ok: true, items });
        },
        () => {
          if (!cancelled) setResult({ key: requestKey, ok: false });
        },
      );
    }, MENTION_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requestKey, trimmed]);

  // Derived, never reset in an effect: an answer for another query is no answer.
  const current = result !== null && result.key === requestKey ? result : null;
  const failed = current !== null && !current.ok;
  const items = current?.ok ? current.items : [];

  // The active row is tracked by id, so a new result set falls back to its first.
  const found = activeId === null ? -1 : items.findIndex((c) => c.id === activeId);
  const active = found >= 0 ? found : 0;
  const retry = () => setAttempt((n) => n + 1);

  // The suggestion keeps focus in the editor and hands ↑ / ↓ / Enter to the
  // listbox as an event (`PICKER_KEY_EVENT`); the latest handler answers it.
  const onKey = (key: string) => {
    if (failed) {
      // The one option is already the active one; Enter retries.
      if (key === 'Enter') retry();
      return;
    }
    if (key === 'Enter') {
      const picked = items[active];
      if (picked) onPick(picked);
      return;
    }
    if (items.length === 0) return;
    const step = key === 'ArrowDown' ? 1 : -1;
    setActiveId(items[(active + step + items.length) % items.length]!.id);
  };
  const onKeyRef = useRef(onKey);
  useEffect(() => {
    onKeyRef.current = onKey;
  });
  const listboxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const listbox = listboxRef.current;
    if (!listbox) return;
    const listener = (event: Event) => onKeyRef.current((event as CustomEvent<string>).detail);
    listbox.addEventListener(PICKER_KEY_EVENT, listener);
    return () => listbox.removeEventListener(PICKER_KEY_EVENT, listener);
  }, []);

  const optionId = (index: number) => `${idBase}-option-${index}`;
  const retryId = `${idBase}-retry`;
  const activeDescendant = failed ? retryId : items.length > 0 ? optionId(active) : undefined;

  let body: ReactNode;
  if (tooShort) {
    body = <p className={HINT}>{messages.typeToSearch}</p>;
  } else if (current === null) {
    body = (
      <p role="status" className={HINT}>
        <Loader2 className="h-3.5 w-3.5 animate-spin text-(--el-text-faint)" aria-hidden />
        {messages.searching}
      </p>
    );
  } else if (failed) {
    body = (
      <>
        <p
          role="alert"
          className="flex items-center justify-center gap-1.5 px-(--spacing-control-x) pt-2 pb-1 text-xs text-(--el-text)"
        >
          <TriangleAlert className="h-3.5 w-3.5 text-(--el-danger-on-surface)" aria-hidden />
          {messages.searchFailed}
        </p>
        <div
          id={retryId}
          role="option"
          aria-selected
          // mousedown, not click: the editor keeps its focus and the `@query`.
          onMouseDown={(event) => {
            event.preventDefault();
            retry();
          }}
          className={`${ROW} justify-center bg-(--el-surface) text-[13px]`}
        >
          <RotateCw className="h-3.5 w-3.5 text-(--el-text-secondary)" aria-hidden />
          {messages.retry}
        </div>
      </>
    );
  } else if (items.length === 0) {
    body = <p className={HINT}>{messages.noResults(trimmed)}</p>;
  } else {
    body = items.map((candidate, index) => (
      <div
        key={candidate.id}
        id={optionId(index)}
        role="option"
        aria-selected={index === active}
        onMouseEnter={() => setActiveId(candidate.id)}
        onMouseDown={(event) => {
          event.preventDefault();
          onPick(candidate);
        }}
        className={index === active ? `${ROW} bg-(--el-surface)` : ROW}
      >
        {renderRow(candidate, index === active)}
      </div>
    ));
  }

  return (
    <div
      ref={listboxRef}
      data-mention-picker
      role="listbox"
      aria-label={label}
      aria-activedescendant={activeDescendant}
      className="z-50 w-max max-w-[22rem] rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-1 leading-[1.4] shadow-(--shadow-elevated)"
    >
      <p className="px-(--spacing-control-x) pt-1.5 pb-1 font-mono text-[10px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
        {messages.workItems}
      </p>
      {body}
    </div>
  );
}

/** The row the package draws when the host passes no renderer: key and title. */
export function defaultPickerRow(candidate: WorkItemCandidate): ReactNode {
  return (
    <>
      <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
        {candidate.identifier}
      </span>
      <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
    </>
  );
}
