'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { MultiSelectOption } from '@/components/ui/MultiSelectPicker';
import { labelTint } from '@/lib/labels/labelTint';
import { LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';
import {
  addLabelAction,
  removeLabelAction,
  addComponentAction,
  removeComponentAction,
} from '../[key]/labelComponentActions';

// The Labels / Components chip-editing LOGIC, extracted (MOTIR-2566).
//
// It used to live inside `LabelsCard` and `ComponentsCard`, fused to their
// `FieldCard` chrome. That was fine while the detail rail was the only surface
// that edited them; the quick-view peek is the second, and its rail is a dense
// <dl> with no card to hang a chevron in. Composing the whole detail card into
// the peek would drag a bordered card and its own edit affordance into a
// definition list, and re-implementing the behaviour would give one field two
// write paths that drift the first time either is fixed.
//
// So the behaviour lives here and both surfaces render it. The hooks own STATE +
// WRITES only; each surface keeps its own chrome, its own open/closed state and
// its own `canEdit` gate, because those are exactly what differ between a
// bordered card and a rail row.
//
// Both write through the SAME Server Actions the detail cards always used, and
// keep the shipped confirm-from-the-response rule: the action's payload is the
// new truth, and nothing calls `router.refresh()` on success (the inline-edit
// rule — `bug-inline-status-revert-on-second-edit`).

const SEARCH_DEBOUNCE_MS = 200;

/**
 * The two surfaces seed from different shapes — the detail page from the full
 * `LabelDto` / `ComponentDto`, the peek from its payload's `{ id, name }` pair —
 * and only `id` and `name` are ever read here. Narrowing the state to that keeps
 * both callers honest without a cast.
 */
export type ChipRef = { id: string; name: string };

export function labelToOption(label: ChipRef): MultiSelectOption {
  return { id: label.id, label: label.name, tint: labelTint(label.name) };
}

export interface ChipEditing {
  /** The attached values, as picker chips. */
  chips: MultiSelectOption[];
  /** The options to offer. */
  options: MultiSelectOption[];
  query: string;
  setQuery: (q: string) => void;
  error: string | null;
  clearError: () => void;
  isPending: boolean;
  toggle: (option: MultiSelectOption) => void;
  remove: (option: MultiSelectOption) => void;
}

export interface LabelEditing extends ChipEditing {
  /** Create-and-attach a label by name (the folksonomy `onCreate`). */
  create: (name: string) => void;
  /** True once the item holds the per-issue cap; the picker shows the hint. */
  atCap: boolean;
}

/**
 * Labels — the folksonomy field. Options come from the bounded, debounced
 * `searchLabels` autocomplete, so the hook only fetches while `active`.
 *
 * `active` is the surface's own open/closed state: the detail card's FieldCard
 * `editing` flag, the peek row's rail-edit key. Keeping it an INPUT rather than
 * hook state is what lets two different chromes drive one behaviour.
 */
export function useLabelEditing({
  workItemId,
  projectKey,
  initialLabels,
  active,
}: {
  workItemId: string;
  projectKey: string;
  initialLabels: ChipRef[];
  active: boolean;
}): LabelEditing {
  const [isPending, startTransition] = useTransition();
  const [labels, setLabels] = useState<ChipRef[]>(initialLabels);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ChipRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Drops a stale autocomplete response that resolves after a newer one (the
  // debounced fetches are not guaranteed to return in order).
  const fetchSeq = useRef(0);

  // The bounded autocomplete (finding #57): a debounced, case-insensitive prefix
  // read over the project's labels; an empty query lists the first window
  // (opening the picker before typing — the Jira field's behaviour).
  useEffect(() => {
    if (!active) return;
    const seq = ++fetchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectKey)}/labels?q=${encodeURIComponent(query.trim())}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { labels: ChipRef[] };
        if (seq === fetchSeq.current) setOptions(body.labels);
      } catch {
        // A failed autocomplete read just leaves the previous window — the
        // create-row still works and the next keystroke retries.
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, query, projectKey]);

  function applyResult(res: Awaited<ReturnType<typeof addLabelAction>>, clearQueryOnOk: boolean) {
    if (res.ok) {
      setLabels(res.labels);
      setError(null);
      if (clearQueryOnOk) setQuery('');
    } else {
      setError(res.error);
    }
  }

  function add(name: string, clearQueryOnOk: boolean) {
    setError(null);
    startTransition(async () => {
      applyResult(await addLabelAction({ workItemId, name }), clearQueryOnOk);
    });
  }

  function remove(value: MultiSelectOption) {
    setError(null);
    startTransition(async () => {
      applyResult(await removeLabelAction({ workItemId, labelId: value.id }), false);
    });
  }

  function toggle(option: MultiSelectOption) {
    if (labels.some((l) => l.id === option.id)) remove(option);
    else add(option.label, false);
  }

  return {
    chips: labels.map(labelToOption),
    options: options.map(labelToOption),
    query,
    setQuery: (q: string) => {
      setQuery(q);
      setError(null);
    },
    error,
    clearError: () => setError(null),
    isPending,
    toggle,
    remove,
    create: (name: string) => add(name, true),
    atCap: labels.length >= LABELS_PER_ISSUE_LIMIT,
  };
}

export interface ComponentEditing extends ChipEditing {
  /** True when the project has no components at all — the admin-link state. */
  emptyTaxonomy: boolean;
}

/**
 * Components — an ADMIN-MANAGED taxonomy, so there is no `onCreate`: the field
 * never grows the vocabulary (mirror: company-managed Jira). Options are the
 * project's components, filtered client-side, so this hook needs no fetch.
 */
export function useComponentEditing({
  workItemId,
  initialComponents,
  projectComponents,
  toOption,
}: {
  workItemId: string;
  initialComponents: ChipRef[];
  projectComponents: ChipRef[];
  /** Each surface supplies the chip presentation (both use the same glyph). */
  toOption: (component: ChipRef) => MultiSelectOption;
}): ComponentEditing {
  const [isPending, startTransition] = useTransition();
  const [components, setComponents] = useState<ChipRef[]>(initialComponents);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  function applyResult(res: Awaited<ReturnType<typeof addComponentAction>>) {
    if (res.ok) {
      setComponents(res.components);
      setError(null);
    } else {
      setError(res.error);
    }
  }

  function toggle(option: MultiSelectOption) {
    setError(null);
    startTransition(async () => {
      const attached = components.some((c) => c.id === option.id);
      applyResult(
        attached
          ? await removeComponentAction({ workItemId, componentId: option.id })
          : await addComponentAction({ workItemId, componentId: option.id }),
      );
    });
  }

  function remove(value: MultiSelectOption) {
    setError(null);
    startTransition(async () => {
      applyResult(await removeComponentAction({ workItemId, componentId: value.id }));
    });
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? projectComponents.filter((c) => c.name.toLowerCase().includes(q))
    : projectComponents;

  return {
    chips: components.map(toOption),
    options: filtered.map(toOption),
    query,
    setQuery: (next: string) => {
      setQuery(next);
      setError(null);
    },
    error,
    clearError: () => setError(null),
    isPending,
    toggle,
    remove,
    emptyTaxonomy: projectComponents.length === 0,
  };
}
