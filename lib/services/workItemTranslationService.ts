import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { batchTranslateFields, type TranslatedField } from '@/lib/ai/translate';
import { requestTranslation, type TranslateTenant } from '@/lib/ai/translateClient';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type {
  TitlesTranslateResponseDTO,
  TranslateResponseDTO,
} from '@/lib/dto/workItemTranslation';
import type { Locale } from '@/lib/i18n/locales';
import {
  toTitlesTranslateResponseDTO,
  toTranslateResponseDTO,
} from '@/lib/mappers/workItemTranslationMappers';
import { FieldLockTimeoutError } from '@/lib/translation/errors';
import { hashFieldText, type TranslatableField } from '@/lib/translation/fieldRevision';
import { assembleFields, type DoorField } from '@/lib/translation/itemFields';
import { fieldRef } from '@/lib/translation/fieldRefs';
import { classifyFields, sourceLanguageOf } from '@/lib/translation/needsTranslation';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { Project } from '@/generated/prisma/client';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { readProject, readWorkItems } from '@/lib/workspaces/tenantRead';
import { fieldLockKey, withFieldLocks } from './translationSingleFlight';
import { workItemTodosService } from './workItemTodosService';
import { workItemTranslationStoreService } from './workItemTranslationStoreService';
import { projectAccessService } from './projectAccessService';
import { billingService } from './billingService';
import { orgCanForWorkspace } from './organizationAccessService';
import { creditOf } from './readerTranslationContextService';
import { workItemsService } from './workItemsService';
import { TITLE_TRANSLATION_MAX_ITEMS } from '@/lib/translation/titleBound';

// The field assembly is pure and lives in `lib/translation/itemFields.ts`, so the
// page-read offer can use it without importing this door (MOTIR-8122).
export { assembleFields, type DoorField };

// THE TRANSLATION DOOR (Story MOTIR-7735 · Subtask MOTIR-8120) — the story's one
// server-side entry point, and the one the auto-translate story calls too.
// Given a work item, a target language and the reader, it answers one result
// per field that NEEDS translating: `ready` with the text (kept, or freshly
// made), or the status of a fresh attempt that could not be made.
//
// The whole item is the unit of a press; the FIELD is the unit of keeping and
// billing. In order: assemble the fields → keep those the classifier says need
// translating → serve the kept ones → lock the rest, re-read the store, send
// only what is still missing in ONE job → keep only on `ok`.
//
// ⚠️ NOTHING IS KEPT ON FAILURE, AND CORE BILLS NOTHING. The charge is made by
// motir-ai when its model turn runs, and a failed run makes none; this door
// adds no billing write and reverses nothing. Keeping after `ok` only is what
// leaves a failed attempt without a row, so a retry translates again.

/** One field's answer. Fields that need no translation are absent from the list. */
export type FieldTranslationResult =
  | { fieldRef: string; status: 'ready'; text: string }
  | { fieldRef: string; status: 'failed' | 'no_credit' | 'timeout'; reason?: string };

export interface TranslateWorkItemInput {
  workItemId: string;
  targetLanguage: Locale;
  /** The reader. Only `userId` / `workspaceId` (and a token's project) are read. */
  actor: ServiceContext;
}

/** The seams a test replaces — every one defaults to the real thing. */
export interface TranslationDoorDeps {
  loadSubject: (
    workItemId: string,
    ctx: ServiceContext,
  ) => Promise<{ item: WorkItemDto; todos: WorkItemTodoDto[] }>;
  store: Pick<typeof workItemTranslationStoreService, 'getKept' | 'keep'>;
  requestTranslation: typeof requestTranslation;
  withFieldLocks: typeof withFieldLocks;
  resolveTenant: (ctx: ServiceContext, projectId: string) => Promise<TranslateTenant>;
}

/** The item and its to-dos, through the same browse-gated reads every item surface uses. */
async function loadSubject(workItemId: string, ctx: ServiceContext) {
  const item = await workItemsService.getWorkItem(workItemId, ctx);
  const { items: todos } = await workItemTodosService.listTodos(workItemId, ctx);
  return { item, todos };
}

/** The payer: the organisation that owns the item's project — never anything from the request. */
async function resolveTenant(ctx: ServiceContext, projectId: string): Promise<TranslateTenant> {
  const project = await readProject(projectId, ctx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new WorkItemNotFoundError(projectId);
  }
  const org = await resolveTenantOrg({ userId: ctx.userId, workspaceId: ctx.workspaceId });
  return {
    organizationId: org.organizationId,
    isMeta: org.isMeta,
    internalBilling: org.internalBilling,
    workspaceId: ctx.workspaceId,
    projectId,
    projectKey: project.identifier,
  };
}

/** The real seams — exported so a test can replace ONE (the client) and keep the rest. */
export const defaultTranslationDoorDeps: TranslationDoorDeps = {
  loadSubject,
  store: workItemTranslationStoreService,
  requestTranslation,
  withFieldLocks,
  resolveTenant,
};

/** The fields the classifier says need translating for `targetLanguage`. */
export function fieldsNeedingTranslation(
  fields: readonly DoorField[],
  targetLanguage: Locale,
): DoorField[] {
  const verdicts = classifyFields(
    fields.map((f) => ({ id: f.fieldRef, text: f.text, language: f.language })),
    targetLanguage,
  );
  const needed = new Set(verdicts.filter((v) => v.needsTranslation).map((v) => v.id));
  return fields.filter((f) => needed.has(f.fieldRef));
}

/** One failure status for each field of `fields`. */
function failAll(
  fields: readonly TranslatableField[],
  status: 'failed' | 'no_credit' | 'timeout',
  reason?: string,
): FieldTranslationResult[] {
  return fields.map((f) => ({ fieldRef: f.fieldRef, status, ...(reason ? { reason } : {}) }));
}

interface PressScope {
  item: WorkItemDto;
  targetLanguage: Locale;
  ctx: ServiceContext;
  tenant: TranslateTenant;
  deps: TranslationDoorDeps;
}

/** Keep every translation of an `ok` answer and return them `ready`. */
async function keepAll(
  scope: PressScope,
  sent: readonly DoorField[],
  translations: readonly TranslatedField[],
): Promise<FieldTranslationResult[]> {
  const out: FieldTranslationResult[] = [];
  for (const [i, field] of sent.entries()) {
    const kept = await scope.deps.store.keep(
      { id: scope.item.id },
      field,
      scope.targetLanguage,
      translations[i]!.text,
      scope.ctx,
    );
    out.push({ fieldRef: field.fieldRef, status: 'ready', text: kept.translatedText });
  }
  return out;
}

/** One job's worth of fields: send it, keep only on `ok`. */
async function sendBatch(
  scope: PressScope,
  batch: readonly DoorField[],
): Promise<FieldTranslationResult[]> {
  const result = await scope.deps.requestTranslation({
    tenant: scope.tenant,
    actor: { userId: scope.ctx.userId },
    targetLanguage: scope.targetLanguage,
    fields: batch.map(({ fieldRef: ref, text }) => ({ fieldRef: ref, text })),
  });
  if (result.status === 'ok') return keepAll(scope, batch, result.translations);
  if (result.status === 'failed') return failAll(batch, 'failed', result.reason);
  return failAll(batch, result.status);
}

/**
 * Inside the locks: re-read the store, send only what is still missing, keep
 * only on `ok`. What is missing goes out in as few jobs as motir-ai's input
 * limits allow (`batchTranslateFields`), sent together so the press waits one
 * deadline, not one per job; a field too long for any job is `failed` unsent.
 */
async function sendUnderLock(
  scope: PressScope,
  missing: readonly DoorField[],
): Promise<FieldTranslationResult[]> {
  const { deps, item, targetLanguage, ctx } = scope;
  const kept = await deps.store.getKept({ id: item.id }, missing, targetLanguage, ctx);
  const ready: FieldTranslationResult[] = Object.entries(kept).map(([ref, text]) => ({
    fieldRef: ref,
    status: 'ready',
    text,
  }));
  const toSend = missing.filter((f) => kept[f.fieldRef] === undefined);
  if (toSend.length === 0) return ready;
  const byRef = new Map(toSend.map((f) => [f.fieldRef, f]));
  const { batches, oversized } = batchTranslateFields(toSend);
  const sent = await Promise.all(
    batches.map((b) =>
      sendBatch(
        scope,
        b.map((f) => byRef.get(f.fieldRef)!),
      ),
    ),
  );
  const tooLong = failAll(
    oversized.map((ref) => byRef.get(ref)!),
    'failed',
    'rejected',
  );
  return [...ready, ...sent.flat(), ...tooLong];
}

/** The fresh half of a press: take the locks, then {@link sendUnderLock}. */
async function translateMissing(
  scope: PressScope,
  missing: readonly DoorField[],
): Promise<FieldTranslationResult[]> {
  const keys = missing.map((f) =>
    fieldLockKey({
      organizationId: scope.tenant.organizationId,
      workItemId: scope.item.id,
      fieldRef: f.fieldRef,
      sourceHash: hashFieldText(f.text),
      targetLanguage: scope.targetLanguage,
    }),
  );
  try {
    return await scope.deps.withFieldLocks(keys, () => sendUnderLock(scope, missing), scope.ctx);
  } catch (err) {
    if (err instanceof FieldLockTimeoutError) return failAll(missing, 'timeout');
    throw err;
  }
}

export const workItemTranslationService = {
  /** The many-titles door (MOTIR-8829), beside {@link translateWorkItem}. */
  async translateTitlesForReader(
    input: TranslateTitlesInput,
    deps?: TitleDoorDeps,
  ): Promise<TitlesTranslateResponseDTO> {
    return toTitlesTranslateResponseDTO(
      input.targetLanguage,
      await translateTitlesForReader(input, deps),
    );
  },

  /**
   * Translate a work item into `targetLanguage` for its reader. Returns one
   * result per field that needs translating, in reading order; a field already
   * in the reader's language, or empty, is absent. A reader who cannot open the
   * item gets `WorkItemNotFoundError`, and nothing is sent.
   */
  async translateWorkItem(
    input: TranslateWorkItemInput,
    deps: TranslationDoorDeps = defaultTranslationDoorDeps,
  ): Promise<FieldTranslationResult[]> {
    const { targetLanguage, actor: ctx } = input;
    const { item, todos } = await deps.loadSubject(input.workItemId, ctx);
    const fields = fieldsNeedingTranslation(assembleFields(item, todos), targetLanguage);
    if (fields.length === 0) return [];
    const kept = await deps.store.getKept({ id: item.id }, fields, targetLanguage, ctx);
    const missing = fields.filter((f) => kept[f.fieldRef] === undefined);
    const fresh = new Map<string, FieldTranslationResult>();
    if (missing.length > 0) {
      const tenant = await deps.resolveTenant(ctx, item.projectId);
      const scope = { item, targetLanguage, ctx, tenant, deps };
      for (const r of await translateMissing(scope, missing)) fresh.set(r.fieldRef, r);
    }
    return fields.map(
      (f): FieldTranslationResult =>
        kept[f.fieldRef] !== undefined
          ? { fieldRef: f.fieldRef, status: 'ready', text: kept[f.fieldRef]! }
          : fresh.get(f.fieldRef)!,
    );
  },

  /**
   * The translate ROUTE's call (MOTIR-8121): {@link translateWorkItem} mapped to
   * the response DTO, which carries status and text only. A `no_credit`,
   * `failed` or `timeout` field is an ordinary entry beside `ready` ones.
   */
  async translateForReader(
    input: TranslateWorkItemInput,
    deps: TranslationDoorDeps = defaultTranslationDoorDeps,
  ): Promise<TranslateResponseDTO> {
    // The browse-gated read, made HERE rather than through the injectable
    // `deps.loadSubject`: the reader-facing door always reads the item as the
    // reader, and stating it in this body is what lets the permission walk
    // (`tests/permissions/noUngovernedOperation.test.ts`) see the gate.
    const subject = await loadSubject(input.workItemId, input.actor);
    const results = await this.translateWorkItem(input, {
      ...deps,
      loadSubject: async () => subject,
    });
    return toTranslateResponseDTO(input.targetLanguage, results);
  },
};

// ─── THE MANY-TITLES DOOR (Subtask MOTIR-8829) ────────────────────────────────
//
// The same door, asked for many work items' TITLES in one request, for the
// auto-translate surfaces (lists, boards, backlog …). A SECOND ENTRY POINT, not a
// second door: it reuses `resolveTenant` (the payer is the organisation that owns
// the project), the store, the lock helper and the client seam, and carries its
// OWN deps so the single-item seam set above is untouched.
//
// ⚠️ THE SWITCH IS THE CEILING ON SPENDING. With the project's auto-translate
// switch off the door answers `enabled: false` having read no title, no store,
// taken no lock and called no client — so a request rendered before the switch was
// turned off cannot charge anything. The single-item press (`translateWorkItem`)
// stays UNGATED: with the switch off the on-demand Translate press must still work.
//
// ⚠️ TWO REFS. A title is SENT under `fieldRef.titleForItem(id)` (motir-ai refuses
// a reply with a duplicate ref, so fifty titles all sent as `title` would be
// refused whole) and KEPT under `fieldRef.title()` on its own item, so this batch
// and the item page read and write the same rows — and the lock key is the
// press's, so a batch and a press for one title cannot both call motir-ai.

/** The most titles one request translates; the excess is `truncated`, not refused. */
export { TITLE_TRANSLATION_MAX_ITEMS };

/** One title the door may translate: the item, its stored title and its recorded language. */
export interface TitleSubject {
  workItemId: string;
  title: string;
  language: string | null;
}

export interface TranslateTitlesInput {
  projectId: string;
  workItemIds: readonly string[];
  targetLanguage: Locale;
  actor: ServiceContext;
}

/** One title's answer. Titles that need no translation, and ids not answerable, are absent. */
export type TitleTranslationResult =
  | {
      workItemId: string;
      fieldRef: string;
      status: 'ready';
      text: string;
      sourceLanguage: Locale | null;
    }
  | { workItemId: string; fieldRef: string; status: 'failed' | 'no_credit' | 'timeout' };

export interface TitleTranslationAnswer {
  enabled: boolean;
  truncated: boolean;
  /** Set only when a title answered `no_credit`: the reader may add credit. */
  canAddCredit?: boolean;
  titles: TitleTranslationResult[];
}

/** The seams a test replaces — every one defaults to the real thing. */
export interface TitleDoorDeps {
  loadProject: (projectId: string, ctx: ServiceContext) => Promise<Project | null>;
  assertCanBrowse: (projectId: string, ctx: ServiceContext) => Promise<void>;
  isAutoTranslateOn: (project: Pick<Project, 'autoTranslateWorkContent'>) => boolean;
  loadSubjects: (
    projectId: string,
    ids: readonly string[],
    ctx: ServiceContext,
  ) => Promise<TitleSubject[]>;
  store: Pick<typeof workItemTranslationStoreService, 'getKeptForTitles' | 'keep'>;
  requestTranslation: typeof requestTranslation;
  withFieldLocks: typeof withFieldLocks;
  resolveTenant: (ctx: ServiceContext, projectId: string) => Promise<TranslateTenant>;
  /** Whether the organisation can pay for a translation — asked only when a title would be sent. */
  hasCredit: (ctx: ServiceContext) => Promise<boolean>;
  /** Whether the reader may manage billing — asked only when a title answered `no_credit`. */
  canAddCredit: (ctx: ServiceContext) => Promise<boolean>;
}

/** The ONE definition of "the project's auto-translate switch is on". */
export function isAutoTranslateOn(project: Pick<Project, 'autoTranslateWorkContent'>): boolean {
  return project.autoTranslateWorkContent === true;
}

/** The items' stored titles through the context-bound batch read; foreign / missing ids are absent. */
async function loadTitleSubjects(
  projectId: string,
  ids: readonly string[],
  ctx: ServiceContext,
): Promise<TitleSubject[]> {
  const rows = await readWorkItems(ids, ctx);
  return rows
    .filter((r) => r.workspaceId === ctx.workspaceId && r.projectId === projectId)
    .map((r) => ({ workItemId: r.id, title: r.title, language: r.titleLanguage }));
}

export const defaultTitleDoorDeps: TitleDoorDeps = {
  loadProject: (projectId, ctx) => readProject(projectId, ctx),
  assertCanBrowse: (projectId, ctx) => projectAccessService.assertCanBrowse(projectId, ctx),
  isAutoTranslateOn,
  loadSubjects: loadTitleSubjects,
  store: workItemTranslationStoreService,
  requestTranslation,
  withFieldLocks,
  resolveTenant,
  hasCredit: async (ctx) =>
    creditOf(
      await billingService.getAiAccessForContext({
        actorUserId: ctx.userId,
        workspaceId: ctx.workspaceId,
      }),
    ) === 'ok',
  canAddCredit: (ctx) => orgCanForWorkspace(ctx.userId, ctx.workspaceId, 'manageBilling'),
};

interface TitleScope {
  projectId: string;
  targetLanguage: Locale;
  ctx: ServiceContext;
  tenant: TranslateTenant;
  deps: TitleDoorDeps;
  sourceLanguages: ReadonlyMap<string, Locale | null>;
}

interface TitleToSend {
  workItemId: string;
  text: string;
}

function titleFail(
  titles: readonly TitleToSend[],
  status: 'failed' | 'no_credit' | 'timeout',
): TitleTranslationResult[] {
  return titles.map((t) => ({
    workItemId: t.workItemId,
    fieldRef: fieldRef.titleForItem(t.workItemId),
    status,
  }));
}

/** One job's worth of titles: send under the per-item refs, keep each on its own item on `ok`. */
async function sendTitleBatch(
  scope: TitleScope,
  batch: readonly TitleToSend[],
): Promise<TitleTranslationResult[]> {
  const result = await scope.deps.requestTranslation({
    tenant: scope.tenant,
    actor: { userId: scope.ctx.userId },
    targetLanguage: scope.targetLanguage,
    fields: batch.map((t) => ({ fieldRef: fieldRef.titleForItem(t.workItemId), text: t.text })),
  });
  if (result.status !== 'ok') {
    return titleFail(batch, result.status === 'failed' ? 'failed' : result.status);
  }
  const byRef = new Map(result.translations.map((t) => [t.fieldRef, t.text]));
  const out: TitleTranslationResult[] = [];
  for (const t of batch) {
    const ref = fieldRef.titleForItem(t.workItemId);
    const kept = await scope.deps.store.keep(
      { id: t.workItemId },
      { fieldRef: fieldRef.title(), text: t.text },
      scope.targetLanguage,
      byRef.get(ref)!,
      scope.ctx,
    );
    out.push({
      workItemId: t.workItemId,
      fieldRef: ref,
      status: 'ready',
      text: kept.translatedText,
      sourceLanguage: scope.sourceLanguages.get(t.workItemId) ?? null,
    });
  }
  return out;
}

/** Inside the locks: re-read the store once, send only what is still missing. */
async function sendTitlesUnderLock(
  scope: TitleScope,
  missing: readonly TitleToSend[],
): Promise<TitleTranslationResult[]> {
  const { deps, projectId, targetLanguage, ctx } = scope;
  const kept = await deps.store.getKeptForTitles(projectId, missing, targetLanguage, ctx);
  const ready: TitleTranslationResult[] = missing
    .filter((t) => kept[t.workItemId] !== undefined)
    .map((t) => ({
      workItemId: t.workItemId,
      fieldRef: fieldRef.titleForItem(t.workItemId),
      status: 'ready',
      text: kept[t.workItemId]!,
      sourceLanguage: scope.sourceLanguages.get(t.workItemId) ?? null,
    }));
  const toSend = missing.filter((t) => kept[t.workItemId] === undefined);
  if (toSend.length === 0) return ready;
  // An organisation that cannot pay sends nothing: the surface says so once.
  if (!(await deps.hasCredit(ctx))) return [...ready, ...titleFail(toSend, 'no_credit')];
  const byRef = new Map(toSend.map((t) => [fieldRef.titleForItem(t.workItemId), t]));
  const { batches, oversized } = batchTranslateFields(
    toSend.map((t) => ({ fieldRef: fieldRef.titleForItem(t.workItemId), text: t.text })),
  );
  const sent = await Promise.all(
    batches.map((b) =>
      sendTitleBatch(
        scope,
        b.map((f) => byRef.get(f.fieldRef)!),
      ),
    ),
  );
  const tooLong = titleFail(
    oversized.map((ref) => byRef.get(ref)!),
    'failed',
  );
  return [...ready, ...sent.flat(), ...tooLong];
}

/** The fresh half: take the press's lock for every missing title, then {@link sendTitlesUnderLock}. */
async function translateMissingTitles(
  scope: TitleScope,
  missing: readonly TitleToSend[],
): Promise<TitleTranslationResult[]> {
  const keys = missing.map((t) =>
    fieldLockKey({
      organizationId: scope.tenant.organizationId,
      workItemId: t.workItemId,
      fieldRef: fieldRef.title(),
      sourceHash: hashFieldText(t.text),
      targetLanguage: scope.targetLanguage,
    }),
  );
  try {
    return await scope.deps.withFieldLocks(
      keys,
      () => sendTitlesUnderLock(scope, missing),
      scope.ctx,
    );
  } catch (err) {
    if (err instanceof FieldLockTimeoutError) return titleFail(missing, 'timeout');
    throw err;
  }
}

/**
 * Translate many of a project's work items' TITLES for their reader. One entry per
 * requested title that needs translating (in the order asked, repeats collapsed,
 * at most {@link TITLE_TRANSLATION_MAX_ITEMS}); a title already in the reader's
 * language, or empty, or whose id this reader may not answer, is absent. A reader
 * who cannot browse the project is refused before anything is read.
 */
export async function translateTitlesForReader(
  input: TranslateTitlesInput,
  deps: TitleDoorDeps = defaultTitleDoorDeps,
): Promise<TitleTranslationAnswer> {
  const { projectId, targetLanguage, actor: ctx } = input;
  const project = await deps.loadProject(projectId, ctx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  await deps.assertCanBrowse(projectId, ctx);
  if (!deps.isAutoTranslateOn(project)) return { enabled: false, truncated: false, titles: [] };

  const unique = [...new Set(input.workItemIds)];
  const truncated = unique.length > TITLE_TRANSLATION_MAX_ITEMS;
  const asked = unique.slice(0, TITLE_TRANSLATION_MAX_ITEMS);
  const subjects = await deps.loadSubjects(projectId, asked, ctx);
  const byId = new Map(subjects.map((s) => [s.workItemId, s]));
  const ordered = asked.map((id) => byId.get(id)).filter((s): s is TitleSubject => s !== undefined);

  const verdicts = classifyFields(
    ordered.map((s) => ({ id: s.workItemId, text: s.title, language: s.language })),
    targetLanguage,
  );
  const needing: TitleSubject[] = [];
  const sourceLanguages = new Map<string, Locale | null>();
  ordered.forEach((s, i) => {
    const verdict = verdicts[i]!;
    if (!verdict.needsTranslation) return;
    needing.push(s);
    sourceLanguages.set(
      s.workItemId,
      sourceLanguageOf({ text: s.title, language: s.language }, verdict),
    );
  });
  if (needing.length === 0) return { enabled: true, truncated, titles: [] };

  const texts: TitleToSend[] = needing.map((s) => ({ workItemId: s.workItemId, text: s.title }));
  const kept = await deps.store.getKeptForTitles(projectId, texts, targetLanguage, ctx);
  const missing = texts.filter((t) => kept[t.workItemId] === undefined);
  const fresh = new Map<string, TitleTranslationResult>();
  if (missing.length > 0) {
    const tenant = await deps.resolveTenant(ctx, projectId);
    const scope: TitleScope = { projectId, targetLanguage, ctx, tenant, deps, sourceLanguages };
    for (const r of await translateMissingTitles(scope, missing)) fresh.set(r.workItemId, r);
  }
  const titles = texts.map(
    (t): TitleTranslationResult =>
      kept[t.workItemId] !== undefined
        ? {
            workItemId: t.workItemId,
            fieldRef: fieldRef.titleForItem(t.workItemId),
            status: 'ready',
            text: kept[t.workItemId]!,
            sourceLanguage: sourceLanguages.get(t.workItemId) ?? null,
          }
        : fresh.get(t.workItemId)!,
  );
  const noCredit = titles.some((t) => t.status === 'no_credit');
  return {
    enabled: true,
    truncated,
    titles,
    ...(noCredit && (await deps.canAddCredit(ctx)) ? { canAddCredit: true } : {}),
  };
}
