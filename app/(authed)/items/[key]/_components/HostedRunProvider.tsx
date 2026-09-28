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
import { useRouter } from 'next/navigation';
import type { DispatchRunOrigin, DispatchRunStatus } from '@/lib/dto/dispatchRuns';

// THE HOSTED-RUN DOOR'S STATE on a work item (Story MOTIR-683 · MOTIR-691;
// `design/runs/design-notes.md` § Hosted runs).
//
// ⚠️ ONE STATE, TWO PLACES ON THE PAGE. The door (the model picker and Run hosted,
// or Cancel run) sits in the Run section's HEADER, and what it answers — a
// refusal, the picker's unavailable/empty notice, the not-ready reason — is drawn
// in the section's BODY. The header is a slot of the server-rendered section
// card, so the two are siblings; this provider is what they share.
//
// ⚠️ THE PAGE-STATE CONTRACT (CLAUDE.md § Page state after a mutation). A start
// and a cancel change two kinds of surface: the Run section's run history is a
// CLIENT island (`useState(initialRuns)`), which `router.refresh()` cannot reach,
// so it watches `runsChangedAt` and refetches; the card's status and the scope
// run are SERVER-rendered, so the same mutation also calls `router.refresh()`.

/** The offered-model read, as the picker draws it: three faces, never one. */
export type HostedModelsState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ok'; models: { id: string; provider: string }[]; default: string | null };

/** One repository a run's App cannot write — the start route's 409 body, verbatim. */
export interface HostedRepositoryRefusal {
  repository: string;
  reason: string;
  fix: string;
  fixUrl: string | null;
}

/** Why a start did not start — drawn on the door, never in the timeline. */
export type HostedRunRefusal =
  | { kind: 'notReady' }
  | { kind: 'outOfCredits' }
  | { kind: 'modelNotOffered'; model: string }
  | { kind: 'notWritable'; repositories: HostedRepositoryRefusal[]; total: number | null }
  | { kind: 'unavailable' }
  | { kind: 'bootFailed' }
  | { kind: 'failed' };

/** The run the door is about: the section's current run, as the section reports it. */
export interface HostedDoorRun {
  id: string;
  origin: DispatchRunOrigin;
  status: DispatchRunStatus;
}

export interface HostedRunContextValue {
  itemKey: string;
  /** The card's OWN readiness — the door's disabled reason. The server re-checks. */
  ready: boolean;
  openBlockers: number;
  models: HostedModelsState;
  selectedModel: string | null;
  selectModel: (id: string) => void;
  reloadModels: () => void;
  refusal: HostedRunRefusal | null;
  starting: boolean;
  start: () => Promise<void>;
  /** The run the door is about, reported by the Run section; null before it does. */
  currentRun: HostedDoorRun | null;
  reportCurrentRun: (run: HostedDoorRun | null) => void;
  /** Bumped by a start or a cancel — the Run section refetches its history on it. */
  runsChangedAt: number;
  /** A run was cancelled from the door or the section. */
  notifyRunsChanged: () => void;
}

const HostedRunContext = createContext<HostedRunContextValue | null>(null);

/** The door's state, or null where no door is mounted (a reader who may not run it). */
export function useHostedRun(): HostedRunContextValue | null {
  return useContext(HostedRunContext);
}

/** The model preselected from a list: the default, else the first offered. */
export function preselectedModel(models: HostedModelsState): string | null {
  if (models.state !== 'ok' || models.models.length === 0) return null;
  if (models.default && models.models.some((m) => m.id === models.default)) return models.default;
  return models.models[0]!.id;
}

async function readModels(): Promise<HostedModelsState> {
  try {
    const res = await fetch('/api/hosted-runs/models', { headers: { Accept: 'application/json' } });
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json()) as {
      models?: { id: string; provider: string }[];
      default?: string | null;
    };
    if (!Array.isArray(body.models)) return { state: 'unavailable' };
    return { state: 'ok', models: body.models, default: body.default ?? null };
  } catch {
    return { state: 'unavailable' };
  }
}

/** The start route's refusal body → the door's refusal. */
function refusalOf(status: number, body: Record<string, unknown>, model: string): HostedRunRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'hosted_model_not_offered') return { kind: 'modelNotOffered', model };
  if (status === 402) return { kind: 'outOfCredits' };
  if (code === 'hosted_repository_not_writable') {
    return {
      kind: 'notWritable',
      repositories: Array.isArray(body.repositories)
        ? (body.repositories as HostedRepositoryRefusal[])
        : [],
      total: typeof body.totalRepositories === 'number' ? body.totalRepositories : null,
    };
  }
  if (code === 'hosted_run_card_not_ready') return { kind: 'notReady' };
  if (code === 'hosted_run_boot_failed') return { kind: 'bootFailed' };
  if (status === 503) return { kind: 'unavailable' };
  return { kind: 'failed' };
}

export function HostedRunProvider({
  itemKey,
  ready,
  openBlockers,
  children,
}: {
  itemKey: string;
  ready: boolean;
  openBlockers: number;
  children: ReactNode;
}) {
  const router = useRouter();
  const [models, setModels] = useState<HostedModelsState>({ state: 'loading' });
  const [chosen, setChosen] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<HostedRunRefusal | null>(null);
  const [starting, setStarting] = useState(false);
  const [currentRun, setCurrentRun] = useState<HostedDoorRun | null>(null);
  const [runsChangedAt, setRunsChangedAt] = useState(0);
  // A reload that resolves after a newer one must not win (CLAUDE.md § the app side).
  const loadSeq = useRef(0);

  const loadModels = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const read = await readModels();
    if (seq !== loadSeq.current) return;
    setModels(read);
    // A model the new list no longer offers is dropped; the preselection takes over.
    setChosen((prev) =>
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

  const selectedModel = chosen ?? preselectedModel(models);

  const notifyRunsChanged = useCallback(() => {
    setRunsChangedAt((n) => n + 1);
    router.refresh();
  }, [router]);

  const start = useCallback(async (): Promise<void> => {
    if (!selectedModel || starting) return;
    setStarting(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/hosted-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      });
      if (res.ok) {
        notifyRunsChanged();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const refused = refusalOf(res.status, body, selectedModel);
      setRefusal(refused);
      // The model was withdrawn between page load and click: re-read the list in
      // place, so the person chooses again without a reload.
      if (refused.kind === 'modelNotOffered') reloadModels();
      // A boot failure OPENED a run and ended it: the history now holds it.
      if (refused.kind === 'bootFailed') notifyRunsChanged();
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      setStarting(false);
    }
  }, [itemKey, notifyRunsChanged, reloadModels, selectedModel, starting]);

  const value = useMemo<HostedRunContextValue>(
    () => ({
      itemKey,
      ready,
      openBlockers,
      models,
      selectedModel,
      selectModel: setChosen,
      reloadModels,
      refusal,
      starting,
      start,
      currentRun,
      reportCurrentRun: setCurrentRun,
      runsChangedAt,
      notifyRunsChanged,
    }),
    [
      itemKey,
      ready,
      openBlockers,
      models,
      selectedModel,
      reloadModels,
      refusal,
      starting,
      start,
      currentRun,
      runsChangedAt,
      notifyRunsChanged,
    ],
  );

  return <HostedRunContext.Provider value={value}>{children}</HostedRunContext.Provider>;
}
