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
import { preselectedModel, readModels, type HostedModelsState } from './hostedModels';

// THE HOSTED MODEL LIST, ONCE PER PAGE (MOTIR-6879; `design/runs/design-notes.md`
// § The model picker and § Continue hosted).
//
// ⚠️ ONE LIST, MANY PRESSES. A page may hold one hosted door (the item page) or
// twenty (the Workbench To fix tab, one per dead-run row); every door reads the
// list and the chosen model from here, so the page makes ONE
// `GET /api/hosted-runs/models` however many doors it draws — MOTIR-6796's
// *fetched once per page*. What each door does with a press is its own
// (`useContinueHosted`).

export interface HostedModelsValue {
  models: HostedModelsState;
  /** The model the person picked, or null while the preselection stands. */
  chosen: string | null;
  setChosen: (id: string) => void;
  /** The chosen model, else the list's preselection — what a press sends. */
  selectedModel: string | null;
  /** Re-read the list in place (a retry, or a model withdrawn since page load). */
  reloadModels: () => void;
}

const HostedModelsContext = createContext<HostedModelsValue | null>(null);

/** The page's model list, or null where no `HostedModelsProvider` is mounted. */
export function useHostedModels(): HostedModelsValue | null {
  return useContext(HostedModelsContext);
}

export function HostedModelsProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<HostedModelsState>({ state: 'loading' });
  const [chosen, setChosenState] = useState<string | null>(null);
  // A reload that resolves after a newer one must not win (CLAUDE.md § the app side).
  const loadSeq = useRef(0);

  const loadModels = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const read = await readModels();
    if (seq !== loadSeq.current) return;
    setModels(read);
    // A model the new list no longer offers is dropped; the preselection takes over.
    setChosenState((prev) =>
      prev && read.state === 'ok' && read.models.some((m) => m.id === prev) ? prev : null,
    );
  }, []);

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

  const value = useMemo<HostedModelsValue>(
    () => ({ models, chosen, setChosen, selectedModel, reloadModels }),
    [models, chosen, setChosen, selectedModel, reloadModels],
  );

  return <HostedModelsContext.Provider value={value}>{children}</HostedModelsContext.Provider>;
}
