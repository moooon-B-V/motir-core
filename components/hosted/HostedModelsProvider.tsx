'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  preselectedModel,
  readModels,
  withoutResolution,
  type HostedModelsState,
} from './hostedModels';

// THE HOSTED MODEL LIST, ONCE PER PAGE (MOTIR-6879; `design/runs/design-notes.md`
// § The model picker and § Continue hosted).
//
// ⚠️ ONE LIST, MANY PRESSES. A page may hold one hosted door (the item page) or
// twenty (the Workbench To fix tab, one per dead-run row); every door reads the
// list and the chosen model from here, so the page makes ONE
// `GET /api/hosted-runs/models` however many doors it draws — MOTIR-6796's
// *fetched once per page*. What each door does with a press is its own
// (`useContinueHosted`).
//
// ⚠️ THE CARD'S OWN MODEL (Story MOTIR-6989 · MOTIR-6996). Given the page's
// `workItemKey`, the one read also carries that card's resolved preselection, and
// Run hosted opens on it. Continue hosted keeps the preselect it always had
// (`continueModel`): a continuation is not re-resolved. A person's own pick is
// `chosen`, and no read — early, late or a reload — ever overwrites it while the
// list still offers it.

export interface HostedModelsValue {
  models: HostedModelsState;
  /** The model the person picked, or null while the preselection stands. */
  chosen: string | null;
  setChosen: (id: string) => void;
  /** The chosen model, else the list's preselection (the card's resolved model
   *  first) — what Run hosted sends. */
  selectedModel: string | null;
  /** The chosen model, else the preselection WITHOUT the card's resolution —
   *  what Continue hosted sends (MOTIR-6996 leaves the continue path as it was). */
  continueModel: string | null;
  /** Re-read the list in place (a retry, or a model withdrawn since page load). */
  reloadModels: () => void;
}

const HostedModelsContext = createContext<HostedModelsValue | null>(null);

/** The page's model list, or null where no `HostedModelsProvider` is mounted. */
export function useHostedModels(): HostedModelsValue | null {
  return useContext(HostedModelsContext);
}

export function HostedModelsProvider({
  workItemKey = null,
  children,
}: {
  /** The card the page is about — its resolved model is preselected. Null on a
   *  surface of many cards (the Workbench), which reads the list alone. */
  workItemKey?: string | null;
  children: ReactNode;
}) {
  const [models, setModels] = useState<HostedModelsState>({ state: 'loading' });
  const [chosen, setChosenState] = useState<string | null>(null);
  // A reload that resolves after a newer one must not win (CLAUDE.md § the app side).
  const loadSeq = useRef(0);

  const loadModels = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const read = await readModels(workItemKey);
    if (seq !== loadSeq.current) return;
    setModels(read);
    // A model the new list no longer offers is dropped; the preselection takes over.
    setChosenState((prev) =>
      prev && read.state === 'ok' && read.models.some((m) => m.id === prev) ? prev : null,
    );
  }, [workItemKey]);

  useEffect(() => {
    void (async () => {
      await loadModels();
    })();
  }, [loadModels]);

  const reloadModels = useCallback(() => {
    setModels({ state: 'loading' });
    void loadModels();
  }, [loadModels]);

  const setChosen = useCallback((id: string) => setChosenState(id), []);

  const selectedModel = chosen ?? preselectedModel(models);
  const continueModel = chosen ?? preselectedModel(withoutResolution(models));

  const value = useMemo<HostedModelsValue>(
    () => ({ models, chosen, setChosen, selectedModel, continueModel, reloadModels }),
    [models, chosen, setChosen, selectedModel, continueModel, reloadModels],
  );

  return <HostedModelsContext.Provider value={value}>{children}</HostedModelsContext.Provider>;
}
