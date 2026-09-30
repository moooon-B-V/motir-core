import type { ClaimActorDto } from '@/lib/dto/claim';

// THE HOSTED DOORS' PURE HELPERS (Story MOTIR-683 · MOTIR-691; Story MOTIR-6527 ·
// MOTIR-6796), lifted out of the item page's `HostedRunProvider` unchanged
// (MOTIR-6879) so a surface other than the item page — the Workbench To fix row —
// can read the same model list and answer a press in the same words.
//
// ⚠️ LIFTED, NOT FORKED. Every function here keeps the body it had in the provider,
// which now imports them back. A change to what a refusal means is made once.

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

/** Why a Continue hosted did not start — Run hosted's answers, less `notReady`
 *  (a continue has no readiness), plus the continue claim's own (MOTIR-6792). */
export type ContinueHostedRefusal =
  | Exclude<HostedRunRefusal, { kind: 'notReady' }>
  | { kind: 'taken'; holder: ClaimActorDto | null; startedAt: string | null }
  | { kind: 'runAlive'; holder: ClaimActorDto | null }
  | { kind: 'nothingPushed' }
  | { kind: 'useFix' }
  | { kind: 'notInProgress' }
  | { kind: 'noDeadRun' }
  | { kind: 'theParent'; parentKey: string | null };

/** Why a *Fix on the hosted agent* did not start (Story MOTIR-1626 · MOTIR-6930) — Run
 *  hosted's answers, less `notReady` (a repair has no readiness), plus the repair claim's
 *  `taken` naming who holds the repair (`hosted_fix_taken`). The start route's
 *  `hosted_fix_not_sent_back` / `hosted_fix_not_repairable` mean the page is STALE — the
 *  card is no longer a review's to repair — so they read as *not started* and the surface
 *  re-reads its view, which then draws no door ({@link fixStateMoved}). */
export type FixHostedRefusal =
  | Exclude<HostedRunRefusal, { kind: 'notReady' }>
  | { kind: 'taken'; holder: ClaimActorDto | null; startedAt: string | null }
  | { kind: 'stale' };

/** The model preselected from a list: the default, else the first offered. */
export function preselectedModel(models: HostedModelsState): string | null {
  if (models.state !== 'ok' || models.models.length === 0) return null;
  if (models.default && models.models.some((m) => m.id === models.default)) return models.default;
  return models.models[0]!.id;
}

export async function readModels(): Promise<HostedModelsState> {
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

const CONTINUE_REFUSALS: Record<string, ContinueHostedRefusal['kind']> = {
  hosted_continue_nothing_pushed: 'nothingPushed',
  hosted_continue_use_fix: 'useFix',
  hosted_continue_not_in_progress: 'notInProgress',
  hosted_continue_no_dead_run: 'noDeadRun',
};

function actorOf(v: unknown): ClaimActorDto | null {
  const o = v as { id?: unknown; name?: unknown } | null;
  return o && typeof o.id === 'string' && typeof o.name === 'string'
    ? { id: o.id, name: o.name }
    : null;
}

/** The start route's answer to a CONTINUE → the continue door's refusal. */
export function continueRefusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): ContinueHostedRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'hosted_continue_taken') {
    return {
      kind: 'taken',
      holder: actorOf(body.holder),
      startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
    };
  }
  if (code === 'hosted_continue_run_alive')
    return { kind: 'runAlive', holder: actorOf(body.holder) };
  if (code === 'hosted_continue_the_parent') {
    return {
      kind: 'theParent',
      parentKey: typeof body.parentKey === 'string' ? body.parentKey : null,
    };
  }
  const kind = CONTINUE_REFUSALS[code];
  if (kind) return { kind } as ContinueHostedRefusal;
  const run = refusalOf(status, body, model);
  // A continue has no readiness: a `not ready` answer would be a stale page, and the
  // nearest true sentence for it is that nothing was started.
  return run.kind === 'notReady' ? { kind: 'failed' } : run;
}

/** A continue refusal that means the page is STALE — its view is re-read (C5a). */
export function continueStateMoved(refusal: ContinueHostedRefusal): boolean {
  return (
    refusal.kind === 'taken' ||
    refusal.kind === 'runAlive' ||
    refusal.kind === 'nothingPushed' ||
    refusal.kind === 'useFix' ||
    refusal.kind === 'notInProgress' ||
    refusal.kind === 'noDeadRun' ||
    refusal.kind === 'theParent' ||
    refusal.kind === 'bootFailed'
  );
}

/** The start route's answer to a FIX → the hosted repair door's refusal (MOTIR-6930). */
export function fixRefusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): FixHostedRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'hosted_fix_taken') {
    return {
      kind: 'taken',
      holder: actorOf(body.holder),
      startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
    };
  }
  if (code === 'hosted_fix_not_sent_back' || code === 'hosted_fix_not_repairable') {
    return { kind: 'stale' };
  }
  const run = refusalOf(status, body, model);
  // A repair has no readiness: a `not ready` answer would be a stale page too.
  return run.kind === 'notReady' ? { kind: 'stale' } : run;
}

/** A fix refusal that means the page is STALE — its view is re-read. NOT `taken`: its
 *  notice names the holder under the door, and the door stays with it until a reload
 *  draws the holder's running repair (design § 30 Panel 3c). */
export function fixStateMoved(refusal: FixHostedRefusal): boolean {
  return refusal.kind === 'stale' || refusal.kind === 'bootFailed';
}

/** One idempotency key per PRESS: a retried request of the same press replays. */
export function pressKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `press-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The start route's refusal body → the door's refusal. */
export function refusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): HostedRunRefusal {
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
