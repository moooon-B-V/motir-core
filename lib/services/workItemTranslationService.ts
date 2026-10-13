import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { TranslatedField } from '@/lib/ai/translate';
import { requestTranslation, type TranslateTenant } from '@/lib/ai/translateClient';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import type { TranslateResponseDTO } from '@/lib/dto/workItemTranslation';
import type { Locale } from '@/lib/i18n/locales';
import { toTranslateResponseDTO } from '@/lib/mappers/workItemTranslationMappers';
import { FieldLockTimeoutError } from '@/lib/translation/errors';
import { fieldRef, hashFieldText, type TranslatableField } from '@/lib/translation/fieldRevision';
import { classifyFields } from '@/lib/translation/needsTranslation';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { readProject } from '@/lib/workspaces/tenantRead';
import { fieldLockKey, withFieldLocks } from './translationSingleFlight';
import { workItemTodosService } from './workItemTodosService';
import { workItemTranslationStoreService } from './workItemTranslationStoreService';
import { workItemsService } from './workItemsService';

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

/** A translatable field with the language its text was recorded in. */
export interface DoorField extends TranslatableField {
  language: string | null;
}

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

/** Every translatable field of the item, in reading order, with its recorded language. */
export function assembleFields(item: WorkItemDto, todos: readonly WorkItemTodoDto[]): DoorField[] {
  const fields: DoorField[] = [
    { fieldRef: fieldRef.title(), text: item.title, language: item.languages.title },
    {
      fieldRef: fieldRef.description(),
      text: item.descriptionMd ?? '',
      language: item.languages.description,
    },
    {
      fieldRef: fieldRef.explanation(),
      text: item.explanationMd ?? '',
      language: item.languages.explanation,
    },
  ];
  for (const todo of todos) {
    fields.push({
      fieldRef: fieldRef.todoText(todo.id),
      text: todo.text,
      language: todo.textLanguage,
    });
    fields.push({
      fieldRef: fieldRef.todoNotes(todo.id),
      text: todo.notesMd ?? '',
      language: todo.notesLanguage,
    });
  }
  return fields;
}

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

/** Inside the locks: re-read the store, send only what is still missing, keep only on `ok`. */
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
  const result = await deps.requestTranslation({
    tenant: scope.tenant,
    actor: { userId: ctx.userId },
    targetLanguage,
    fields: toSend.map(({ fieldRef: ref, text }) => ({ fieldRef: ref, text })),
  });
  if (result.status === 'ok')
    return [...ready, ...(await keepAll(scope, toSend, result.translations))];
  if (result.status === 'failed') return [...ready, ...failAll(toSend, 'failed', result.reason)];
  return [...ready, ...failAll(toSend, result.status)];
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
