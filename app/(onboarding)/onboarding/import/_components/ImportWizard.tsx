'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { StepRail, type WizardStep } from './StepRail';
import {
  ConnectStep,
  type ConnectionDraft,
  emptyDraft,
  seedDraft,
  buildConnection,
} from './ConnectStep';
import { MapStep, buildInitialMapping, countUnresolved } from './MapStep';
import { PreviewStep } from './PreviewStep';
import { RunStep } from './RunStep';
import {
  createDraft,
  discover,
  preview as runPreview,
  ImportApiError,
  type ImportSourceId,
  type Mapping,
  type DiscoverResult,
  type PreviewResult,
} from './importClient';

export interface WizardStatusOption {
  key: string;
  label: string;
  category: string;
}

export interface WizardConnected {
  connected: boolean;
  siteUrl?: string;
  baseUrl?: string;
  workspaceSlug?: string;
}

export interface ImportWizardProps {
  project: { id: string; name: string };
  statuses: WizardStatusOption[];
  connected: Record<'jira' | 'linear' | 'github' | 'plane', WizardConnected>;
  existingImportId: string | null;
  /** A source just returned from an OAuth round-trip (`?jira=connected` …), so
   *  the wizard can re-select it and surface a connect result/error. */
  justConnected?: { source: ImportSourceId | null; failed: boolean };
}

/**
 * The import wizard client island (Story 7.16 · MOTIR-942) — the stepped
 * connect → map → dry-run preview → run flow. It owns the step state machine and
 * drives the 7.16.5 API routes (create draft → discover → preview → run); it
 * never touches the service layer directly (the 4-layer boundary). The Import
 * (run) step is UNREACHABLE until the dry-run preview has been reviewed
 * (`previewed`) — the confirm-before-write gate made visible (design Panel 0/3).
 */
export function ImportWizard({
  project,
  statuses,
  connected,
  existingImportId,
  justConnected,
}: ImportWizardProps) {
  const t = useTranslations('import');

  const [step, setStep] = useState<WizardStep>('connect');
  const initialSource = justConnected?.source ?? null;
  const [source, setSource] = useState<ImportSourceId | null>(initialSource);
  const [draft, setDraft] = useState<ConnectionDraft>(() =>
    initialSource && initialSource !== 'csv'
      ? { ...emptyDraft, ...seedDraft(connected[initialSource]) }
      : emptyDraft,
  );
  const [importId, setImportId] = useState<string | null>(existingImportId);

  const [discovered, setDiscovered] = useState<DiscoverResult | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [previewed, setPreviewed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string } | null>(null);

  const connection = useMemo(
    () => (source ? buildConnection(source, draft) : null),
    [source, draft],
  );

  // Live sources also require an established OAuth connection; CSV needs none.
  const connectReady = source === 'csv' ? true : source ? connected[source].connected : false;
  const canProceed = Boolean(connection) && connectReady && !busy;

  const unresolved = useMemo(
    () => (discovered ? countUnresolved(discovered.vocabulary, mapping) : 0),
    [discovered, mapping],
  );

  /** Ensure a draft Import exists for this project+source, reusing the id. */
  const ensureImport = useCallback(
    async (src: ImportSourceId): Promise<string> => {
      if (importId) return importId;
      const created = await createDraft(project.id, src);
      setImportId(created.id);
      return created.id;
    },
    [importId, project.id],
  );

  /** Connect → Map: probe the source (reachability + field vocabulary), seed the
   *  proposed mapping, advance. A pre-flight failure keeps us on Connect and
   *  shows the typed error (never a silent advance). */
  const goToMap = useCallback(async () => {
    if (!source || !connection) return;
    setBusy(true);
    setError(null);
    try {
      const id = await ensureImport(source);
      const result = await discover(id, connection);
      setDiscovered(result);
      setMapping((prev) => buildInitialMapping(result.vocabulary, statuses, prev));
      setStep('map');
    } catch (err) {
      setError({ code: err instanceof ImportApiError ? err.code : 'UNKNOWN' });
    } finally {
      setBusy(false);
    }
  }, [source, connection, ensureImport, statuses]);

  /** Map → Preview: run the dry run and open the (now-reviewable) gate. */
  const goToPreview = useCallback(async () => {
    if (!importId || !connection || unresolved > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runPreview(importId, mapping, connection);
      setPreviewResult(result);
      setPreviewed(true);
      setStep('preview');
    } catch (err) {
      setError({ code: err instanceof ImportApiError ? err.code : 'UNKNOWN' });
    } finally {
      setBusy(false);
    }
  }, [importId, connection, mapping, unresolved]);

  const backTo = useCallback((target: WizardStep) => {
    setError(null);
    setStep(target);
  }, []);

  const chromeTitle = t('chrome.titleInto', { project: project.name });

  return (
    <div className="mx-auto w-full max-w-[64rem] px-6 py-10">
      <Card className="flex flex-col gap-6">
        <header className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-(--el-text-strong)">{chromeTitle}</h1>
            {step === 'preview' ? (
              <p className="text-sm text-(--el-text-muted)">{t('chrome.dryRun')}</p>
            ) : null}
          </div>
          <StepRail current={step} previewed={previewed} />
        </header>

        {step === 'connect' ? (
          <ConnectStep
            source={source}
            onSelectSource={(s) => {
              setSource(s);
              setError(null);
            }}
            draft={draft}
            onDraftChange={setDraft}
            connected={connected}
            canProceed={canProceed}
            busy={busy}
            error={error}
            justConnectedFailed={justConnected?.failed ?? false}
            onNext={goToMap}
          />
        ) : null}

        {step === 'map' && discovered ? (
          <MapStep
            source={source as ImportSourceId}
            sourceRef={discovered.connect.sourceRef}
            issueCount={discovered.connect.issueCount}
            vocabulary={discovered.vocabulary}
            statuses={statuses}
            mapping={mapping}
            onMappingChange={setMapping}
            unresolved={unresolved}
            busy={busy}
            error={error}
            onBack={() => backTo('connect')}
            onNext={goToPreview}
          />
        ) : null}

        {step === 'preview' && previewResult ? (
          <PreviewStep
            result={previewResult}
            busy={busy}
            onBack={() => backTo('map')}
            onConfirm={() => setStep('run')}
          />
        ) : null}

        {step === 'run' && importId && connection ? (
          <RunStep
            importId={importId}
            connection={connection}
            mapping={mapping}
            project={project}
            confirmCount={
              previewResult ? previewResult.counts.create + previewResult.counts.update : 0
            }
          />
        ) : null}
      </Card>
    </div>
  );
}
