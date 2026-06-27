'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ReactRenderer, type Editor } from '@tiptap/react';
import { Mention } from '@tiptap/extension-mention';
import { Node, mergeAttributes } from '@tiptap/core';
import { Loader2 } from 'lucide-react';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';
import { cn } from '@/lib/utils/cn';

// Mention capability for the shared MarkdownEditor. Typing `@` opens a
// caret-anchored UNIFIED picker (Subtask 5.8.5, the Linear-faithful single `@`)
// — `design/work-items/internal-links.mock.html` panel 3 — offering BOTH:
//
//  · People — the shipped 5.1.4 path (Avatar · name · email), UNCHANGED. A pick
//    inserts an atomic `mention` node serializing to `[@Display Name](mention:<userId>)`.
//  · Work items — fetched query-driven + DEBOUNCED from a host-supplied async
//    search (the type-icon · mono key · title · status Pill row). A pick inserts
//    a `workItemMention` node serializing to `[<KEY>](motir:<workItemId>)` — the
//    durable token `lib/mentions/workItemRefs.ts` owns, the exact parallel of the
//    user token.
//
// The body stays plain Markdown: one storage format, no parallel rich-text blob.
// The host surface supplies BOTH the candidates (`mentionCandidates`) and the
// work-item search (`workItemSearch`) on MarkdownEditor; this module stays
// data-source-agnostic. Without EITHER prop the extension is never registered
// and the editor is byte-identical to before 5.1.4. With only `mentionCandidates`
// the picker is people-only (no "Work items" section appears) — the existing
// consumers are untouched.
//
// Round-trip: tiptap-markdown loads Markdown via markdown-it, which renders each
// token as `<a href="mention:<id>">@Name</a>` / `<a href="motir:<id>">KEY</a>`
// (markdown-it's validateLink only blocks javascript:/vbscript:/file:/data:). A
// high-priority parseHTML rule converts each anchor into the matching node, and
// `storage.markdown.serialize` writes the token back out — load → edit →
// getMarkdown() is stable for BOTH token families.

export interface MentionCandidate {
  id: string;
  /** Display name — becomes the token's `@Display Name` label. */
  name: string;
  /** Secondary line in the picker (right-aligned, muted). */
  email?: string | null;
}

/** The Pill tone the picker renders for a work item's current status. Mirrors
 * the design's row Pill: lifecycle category → `planned`/`in-progress`/`done`,
 * with `blocked` → warning and any unknown/terminal key → a neutral chip. */
export type WorkItemMentionStatusTone = 'planned' | 'in-progress' | 'done' | 'warning' | 'neutral';

/** One work-item candidate row in the unified `@` picker (5.8.5) — the design's
 * link-row vocabulary: type-icon hue · mono key · title · status Pill. The
 * inserted token's label is the `identifier` (the KEY); its payload is `id`. */
export interface WorkItemMentionCandidate {
  /** Work-item id — the `motir:<id>` token payload. */
  id: string;
  /** The current key (e.g. `MOTIR-805`) — the mono row label AND the token's
   * bracket label. */
  identifier: string;
  title: string;
  /** Work-item kind — picks the IssueTypeIcon hue. */
  kind: WorkItemKindDto;
  /** Current status for the row Pill, or null when the stored status no longer
   * resolves to a workflow status. */
  status: { label: string; tone: WorkItemMentionStatusTone } | null;
}

/** The host-supplied async, debounced work-item search behind the picker's
 * "Work items" section. Returns at most a small page (the endpoint caps it). */
export type WorkItemMentionSearch = (query: string) => Promise<WorkItemMentionCandidate[]>;

/** Localised picker copy the host (next-intl) hands down — the popup is mounted
 * through ReactRenderer (outside the next-intl React context), so the strings
 * come in as props, never `useTranslations` inside the popup. */
export interface MentionPickerLabels {
  people: string;
  workItems: string;
  typeToSearch: string;
  searching: string;
  noResults: (query: string) => string;
}

/** Wiring the editor hands the extension at create time. The callbacks read
 * refs so candidate updates never recreate the editor. */
export interface MentionWiring {
  getCandidates: () => MentionCandidate[];
  /** The positioned ancestor the popup mounts into (the editor's bordered
   * wrapper). Absolute coords relative to it work inside a Radix Dialog too —
   * a body portal there hits the focus-trap/pointer-events/transform traps the
   * Combobox already documents, so the popup never portals. */
  getAnchor: () => HTMLElement | null;
  /** The async work-item search (5.8.5). Absent → the picker is people-only and
   * the `workItemMention` node is not registered (pre-5.8.5 behaviour). */
  searchWorkItems?: WorkItemMentionSearch;
  /** Localised picker copy; English defaults are used when omitted (tests). */
  labels?: MentionPickerLabels;
}

const MENTION_ID_RE = /^[A-Za-z0-9_-]+$/;
/** The `motir:` href payload — the cuid charset, mirroring WORKITEM_HREF_RE. */
const WORKITEM_MENTION_ID_RE = /^[A-Za-z0-9_-]+$/;

const DEFAULT_LABELS: MentionPickerLabels = {
  people: 'People',
  workItems: 'Work items',
  typeToSearch: 'Keep typing to search work items…',
  searching: 'Searching…',
  noResults: (query) => `No work items match “${query}”.`,
};

/** One settled keystroke per server fetch — long enough to coalesce a fast
 * typer (the `useLinkCandidateSearch` debounce). */
const WORKITEM_SEARCH_DEBOUNCE_MS = 250;

/** The tagged item the picker hands back to the suggestion `command`, which
 * branches it to the matching node. */
export type PickedMention =
  | { type: 'user'; id: string; label: string }
  | { type: 'workItem'; id: string; label: string };

interface MentionListProps {
  /** The filtered people candidates (the suggestion `items()` output). */
  people: MentionCandidate[];
  /** The live `@` query (the text after the trigger), driving the work search. */
  query: string;
  /** Present → the picker shows the "Work items" section; absent → people-only. */
  searchWorkItems?: WorkItemMentionSearch;
  labels?: MentionPickerLabels;
  command: (picked: PickedMention) => void;
}

export interface MentionListHandle {
  onKeyDown: (args: { event: KeyboardEvent | ReactKeyboardEvent }) => boolean;
}

/** The work item's status as a Pill, by the design's row tone. */
function StatusPill({ status }: { status: { label: string; tone: WorkItemMentionStatusTone } }) {
  switch (status.tone) {
    case 'planned':
      return <Pill status="planned">{status.label}</Pill>;
    case 'in-progress':
      return <Pill status="in-progress">{status.label}</Pill>;
    case 'done':
      return <Pill status="done">{status.label}</Pill>;
    case 'warning':
      return <Pill severity="warning">{status.label}</Pill>;
    case 'neutral':
      return <Pill tone="neutral">{status.label}</Pill>;
  }
}

/**
 * The caret-anchored unified picker (5.1.4 people + 5.8.5 work items). Focus
 * stays in the editor (the suggestion plugin forwards key events here), so the
 * active row is conveyed with `aria-activedescendant` on the listbox +
 * `aria-selected` on the row. The combined option list is People rows followed
 * by Work-item rows; ↑/↓ wrap across BOTH sections and Enter commits the active
 * row as its matching token. Option ids are `mention-option-<globalIndex>`, so
 * the people-only path is byte-identical to before 5.8.5.
 */
export const MentionList = forwardRef<MentionListHandle, MentionListProps>(function MentionList(
  { people, query, searchWorkItems, labels, command },
  ref,
) {
  const unified = Boolean(searchWorkItems);
  const copy = labels ?? DEFAULT_LABELS;

  // The active row is tracked by its stable identity KEY, not an index — so when
  // the option set changes (work-item results arrive, the filter narrows) the
  // active row falls back to the first automatically (the key is no longer
  // present → index 0), with NO reset effect and NO ref-during-render. A no-op
  // `updateProps` (the suggestion plugin re-emits an equal-content `people`
  // array on a keystroke that only moved the active row) leaves the key — and so
  // the selection — untouched.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [workItems, setWorkItems] = useState<WorkItemMentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);

  const trimmed = query.trim();
  const tooShort = trimmed.length < QUICK_SEARCH_MIN_QUERY_LENGTH;

  // The search closure can change identity per render — read it through a ref so
  // it isn't a fetch-effect dependency (the `useLinkCandidateSearch` precedent).
  const searchRef = useRef(searchWorkItems);
  useEffect(() => {
    searchRef.current = searchWorkItems;
  });

  // Debounced work-item search — a legit subscription effect (timer + cleanup),
  // resetting loading/results around the async call (the data-fetch precedent).
  useEffect(() => {
    const search = searchRef.current;
    if (!search || tooShort) {
      setLoading(false);
      setWorkItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      search(trimmed).then(
        (results) => {
          if (cancelled) return;
          setLoading(false);
          setWorkItems(results);
        },
        () => {
          if (cancelled) return;
          setLoading(false);
          setWorkItems([]);
        },
      );
    }, WORKITEM_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, tooShort, unified]);

  // The combined option list — People then Work items (the design's section
  // order). The global index is the keyboard / aria-activedescendant space.
  const options: PickedMention[] = [
    ...people.map((p): PickedMention => ({ type: 'user', id: p.id, label: p.name })),
    ...workItems.map((w): PickedMention => ({ type: 'workItem', id: w.id, label: w.identifier })),
  ];
  const keyOf = (o: PickedMention) => `${o.type}:${o.id}`;

  // The active index derives from the active KEY — found in the current set, or
  // the first row when the key is gone (set changed) or none chosen yet.
  const foundIndex = activeKey == null ? -1 : options.findIndex((o) => keyOf(o) === activeKey);
  const active = foundIndex >= 0 ? foundIndex : 0;

  const select = (index: number) => {
    const picked = options[index];
    if (picked) command(picked);
  };
  const moveTo = (index: number) => {
    const picked = options[index];
    if (picked) setActiveKey(keyOf(picked));
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        if (options.length > 0) moveTo((active + 1) % options.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        if (options.length > 0) moveTo((active - 1 + options.length) % options.length);
        return true;
      }
      if (event.key === 'Enter') {
        select(active);
        return true;
      }
      return false;
    },
  }));

  const peopleStart = 0;
  const workItemsStart = people.length;

  return (
    <div
      role="listbox"
      aria-label={unified ? 'Mention a person or work item' : 'Mention a member'}
      aria-activedescendant={options.length > 0 ? `mention-option-${active}` : undefined}
      className={cn(
        'border-(--el-border) bg-(--el-page-bg) shadow-(--shadow-elevated) z-50 w-max rounded-(--radius-card) border p-1',
        unified ? 'max-w-[22rem]' : 'max-w-[18rem]',
      )}
    >
      {!unified && people.length === 0 ? (
        <p className="text-(--el-text-muted) px-(--spacing-control-x) py-(--spacing-control-y) text-sm">
          No matches
        </p>
      ) : null}

      {/* People section. In the people-only path no header is shown (byte-
          identical to before 5.8.5); the unified picker labels it. */}
      {unified && people.length > 0 ? (
        <p className="text-(--el-text-secondary) px-(--spacing-control-x) pt-1.5 pb-1 font-mono text-[10px] font-semibold tracking-wider uppercase">
          {copy.people}
        </p>
      ) : null}
      {people.map((item, i) => {
        const index = peopleStart + i;
        return (
          <div
            key={item.id}
            id={`mention-option-${index}`}
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => moveTo(index)}
            // mousedown, not click: the editor keeps focus/selection, so the
            // suggestion range is still there for the command to replace.
            onMouseDown={(event) => {
              event.preventDefault();
              select(index);
            }}
            className={cn(
              'flex min-w-55 cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
              index === active ? 'bg-(--el-surface) text-(--el-text)' : 'text-(--el-text)',
            )}
          >
            <span
              className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
              aria-hidden
            >
              {item.name.charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{item.name}</span>
            {item.email ? (
              // The active row sits on the --el-surface tint, where muted text
              // drops under WCAG AA (4.17:1) — step up to secondary there
              // (6.2:1); inactive rows stay muted on the page bg (4.54:1).
              <span
                className={cn(
                  'ml-auto truncate text-xs',
                  index === active ? 'text-(--el-text-secondary)' : 'text-(--el-text-muted)',
                )}
              >
                {item.email}
              </span>
            ) : null}
          </div>
        );
      })}

      {/* Work items section — only in the unified picker. Shows the type-to-
          search / loading / no-results states per the design, else the rows. */}
      {unified ? (
        <>
          <p className="text-(--el-text-secondary) px-(--spacing-control-x) pt-1.5 pb-1 font-mono text-[10px] font-semibold tracking-wider uppercase">
            {copy.workItems}
          </p>
          {tooShort ? (
            <p className="text-(--el-text-muted) px-(--spacing-control-x) py-2 text-center text-xs">
              {copy.typeToSearch}
            </p>
          ) : loading ? (
            <p className="text-(--el-text-muted) flex items-center justify-center gap-1.5 px-(--spacing-control-x) py-2 text-center text-xs">
              <Loader2 className="text-(--el-text-faint) h-3.5 w-3.5 animate-spin" aria-hidden />
              {copy.searching}
            </p>
          ) : workItems.length === 0 ? (
            <p className="text-(--el-text-muted) px-(--spacing-control-x) py-2 text-center text-xs">
              {copy.noResults(trimmed)}
            </p>
          ) : (
            workItems.map((item, i) => {
              const index = workItemsStart + i;
              return (
                <div
                  key={item.id}
                  id={`mention-option-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => moveTo(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(index);
                  }}
                  className={cn(
                    'flex min-w-70 cursor-pointer items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
                    index === active ? 'bg-(--el-surface) text-(--el-text)' : 'text-(--el-text)',
                  )}
                >
                  <IssueTypeIcon
                    type={item.kind as IssueType}
                    className="h-[15px] w-[15px] shrink-0"
                  />
                  <span
                    className={cn(
                      'shrink-0 font-mono text-xs',
                      // muted drops under AA (4.5:1) on the active row's
                      // --el-surface tint — step up to secondary there, as the
                      // people row's email does.
                      index === active ? 'text-(--el-text-secondary)' : 'text-(--el-text-muted)',
                    )}
                  >
                    {item.identifier}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.status ? (
                    <span className="ml-auto shrink-0">
                      <StatusPill status={item.status} />
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </>
      ) : null}
    </div>
  );
});

/** Filter candidates the Combobox way — name OR email substring match. */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const matched =
    needle === ''
      ? candidates
      : candidates.filter(
          (c) =>
            c.name.toLowerCase().includes(needle) ||
            (c.email ? c.email.toLowerCase().includes(needle) : false),
        );
  return matched.slice(0, 8);
}

/**
 * The `workItemMention` node (Subtask 5.8.5) — the richer sibling of the user
 * `mention` node. An atomic inline node that:
 *  - SERIALIZES to `[<KEY>](motir:<workItemId>)` (the durable token);
 *  - ROUND-TRIPS via a high-priority parseHTML rule on `a[href^="motir:"]` (what
 *    markdown-it renders the stored token as on load), outranking the Link mark;
 *  - `renderText` → the bare KEY;
 *  - renders inline in the editor as a `.wi-chip` (mono key) — consistent with
 *    the read-only chip (5.8.6); it doesn't need the live peek inside the editor.
 *
 * Registered only when `workItemSearch` is wired, so a non-work-item editor's
 * schema (and its round-trip) is exactly the pre-5.8.5 one.
 */
export function buildWorkItemMentionExtension() {
  return Node.create({
    name: 'workItemMention',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        id: { default: null },
        /** The bracket label — the work item's key (e.g. `MOTIR-805`). */
        label: { default: null },
      };
    },

    addStorage() {
      return {
        markdown: {
          serialize(
            state: { write: (text: string) => void },
            node: { attrs: { id: string; label: string | null } },
          ) {
            state.write(`[${node.attrs.label ?? ''}](motir:${node.attrs.id})`);
          },
          parse: {}, // load-side parsing is the parseHTML rule below
        },
      };
    },

    parseHTML() {
      return [
        // What the editor itself emits (copy/paste within the editor).
        { tag: 'span[data-type="workItemMention"]' },
        // What markdown-it emits for the stored token on load. Higher priority
        // than the Link mark's generic `a[href]` rule so the anchor becomes a
        // work-item node, not a link. A malformed id falls to the Link mark
        // (and degrades to plain text — `motir:` isn't an allowed link scheme).
        {
          tag: 'a[href^="motir:"]',
          priority: 1000,
          getAttrs: (element) => {
            const el = element as HTMLElement;
            const id = (el.getAttribute('href') ?? '').slice('motir:'.length);
            if (!WORKITEM_MENTION_ID_RE.test(id)) return false;
            const label = (el.textContent ?? '').trim();
            return { id, label };
          },
        },
      ];
    },

    renderHTML({ node, HTMLAttributes }) {
      const label = (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
      return [
        'span',
        mergeAttributes(HTMLAttributes, { 'data-type': 'workItemMention', class: 'wi-chip' }),
        ['span', { class: 'wi-key' }, label],
      ];
    },

    renderText({ node }) {
      return (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
    },
  });
}

/**
 * The configured tiptap Mention extension. Builds on the official extension
 * (atomic inline node, suggestion plugin) and adds:
 *  - Markdown serialization to `[@Name](mention:<id>)` (tiptap-markdown spec);
 *  - a parseHTML rule for the `<a href="mention:…">` markdown-it produces on
 *    load, outranking the Link mark so the token round-trips as a node;
 *  - the designed chip rendering in the editor (`mention-chip`, styled in
 *    markdown-editor.css — the same class MarkdownView's renderer emits);
 *  - the caret-anchored UNIFIED picker (people + work items, 5.8.5), absolutely
 *    positioned inside the editor wrapper (never a body portal — see
 *    MentionWiring.getAnchor). A single `@` suggestion drives both sections: its
 *    `command` branches the picked item to the user `mention` node or the
 *    `workItemMention` node (two extensions sharing the `@` char would conflict).
 */
export function buildMentionExtension(wiring: MentionWiring) {
  return Mention.extend({
    addStorage() {
      return {
        markdown: {
          serialize(
            state: { write: (text: string) => void },
            node: { attrs: { id: string; label: string | null } },
          ) {
            state.write(`[@${node.attrs.label ?? ''}](mention:${node.attrs.id})`);
          },
          parse: {}, // load-side parsing is the parseHTML rule below
        },
      };
    },
    parseHTML() {
      return [
        // What the editor itself emits (copy/paste within the editor).
        { tag: 'span[data-type="mention"]' },
        // What markdown-it emits for the stored token on load. Higher priority
        // than the Link mark's generic `a[href]` rule so the anchor becomes a
        // mention node, not a link. A malformed id is left to the Link mark
        // (and degrades to plain text on the render side).
        {
          tag: 'a[href^="mention:"]',
          priority: 1000,
          getAttrs: (element) => {
            const el = element as HTMLElement;
            const id = (el.getAttribute('href') ?? '').slice('mention:'.length);
            if (!MENTION_ID_RE.test(id)) return false;
            const label = (el.textContent ?? '').replace(/^@/, '');
            return { id, label };
          },
        },
      ];
    },
  }).configure({
    HTMLAttributes: { class: 'mention-chip' },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: {
      char: '@',
      // People only — the work-item rows are fetched (debounced) inside the
      // popup off the live query, so they never block the keystroke.
      items: ({ query }) => filterMentionCandidates(wiring.getCandidates(), query),
      // The unified insert: branch the picked tagged item to its node. Mirrors
      // the official Mention command (range delete + trailing space), but the
      // node type follows the pick.
      command: ({ editor, range, props }) => {
        const picked = props as unknown as PickedMention;
        const nodeAfter = editor.view.state.selection.$to.nodeAfter;
        const overrideSpace = nodeAfter?.text?.startsWith(' ');
        if (overrideSpace) range.to += 1;
        const nodeType = picked.type === 'workItem' ? 'workItemMention' : 'mention';
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: nodeType, attrs: { id: picked.id, label: picked.label } },
            { type: 'text', text: ' ' },
          ])
          .run();
        window.getSelection()?.collapseToEnd();
      },
      render: () => {
        let component: ReactRenderer<MentionListHandle, MentionListProps> | null = null;
        let popup: HTMLElement | null = null;

        // Anchor the popup at the caret: clientRect is in viewport coords, the
        // popup is absolutely positioned inside the (relative) editor wrapper,
        // so translate via the wrapper's own rect.
        const position = (clientRect: (() => DOMRect | null) | null | undefined) => {
          const anchor = wiring.getAnchor();
          if (!popup || !anchor) return;
          let rect: DOMRect | null = null;
          try {
            rect = clientRect?.() ?? null;
          } catch {
            // Layout-less environments (tests) can't measure the caret; the
            // popup still mounts, just unpositioned.
          }
          if (!rect) return;
          const anchorRect = anchor.getBoundingClientRect();
          popup.style.left = `${Math.round(rect.left - anchorRect.left)}px`;
          popup.style.top = `${Math.round(rect.bottom - anchorRect.top + 4)}px`;
        };

        const destroy = () => {
          popup?.remove();
          popup = null;
          component?.destroy();
          component = null;
        };

        const propsFor = (p: { items: MentionCandidate[]; query: string; command: unknown }) => ({
          people: p.items,
          query: p.query,
          searchWorkItems: wiring.searchWorkItems,
          labels: wiring.labels,
          command: p.command as (picked: PickedMention) => void,
        });

        return {
          onStart: (props) => {
            const anchor = wiring.getAnchor();
            if (!anchor) return;
            component = new ReactRenderer(MentionList, {
              props: propsFor(props),
              editor: props.editor as Editor,
            });
            popup = document.createElement('div');
            popup.style.position = 'absolute';
            popup.style.zIndex = '50';
            popup.appendChild(component.element);
            anchor.appendChild(popup);
            position(props.clientRect);
          },
          onUpdate: (props) => {
            component?.updateProps(propsFor(props));
            position(props.clientRect);
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              destroy();
              return true;
            }
            return component?.ref?.onKeyDown({ event: props.event }) ?? false;
          },
          onExit: destroy,
        };
      },
    },
  });
}
