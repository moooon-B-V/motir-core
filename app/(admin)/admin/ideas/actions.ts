'use server';

import { revalidatePath } from 'next/cache';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { consoleIdeaActor } from '@/lib/ideas/consoleActor';
import {
  IdeaNotActiveError,
  IdeaNotFoundError,
  InvalidIdeaInputError,
  UnknownIdeaTagError,
} from '@/lib/ideas/errors';
import { ideaPatchBodySchema, reasonBodySchema } from '@/lib/ideas/schemas';
import type { IdeaPatch } from '@/lib/ideas/types';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { ideasAdminService } from '@/lib/services/ideasAdminService';

/**
 * The console's IDEA writes — design `platform-admin/design-notes.md` § Ideas,
 * Panels 6–9, card MOTIR-7681.
 *
 * Transport only, the `planning-lessons/actions.ts` shape: resolve the platform
 * principal at the action's own level, build the console's `IdeaActor`
 * (credential `session`, so every audit row says so), call ONE service method,
 * and translate the typed errors into the result the page draws. What is valid,
 * who may delete and the audit row are `ideasAdminService`'s.
 *
 * ⚠️ THE GATE IS ASSERTED HERE AND AGAIN IN THE SERVICE. A Server Action is a
 * POST the `(admin)` layout never renders, so it resolves the principal itself;
 * a support user who calls one directly gets `not_permitted`, as does an
 * operator calling delete.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production, and the page draws a different answer for each refusal.
 */

/** One field the page marks in place. `field` is the service's path (`evidence[1].url`). */
export interface IdeaFieldIssue {
  field: string;
  /** The unknown tag's slug, for `UNKNOWN_TAG` on the Tags field. */
  tag?: string;
}

/** A refusal the page answers with a message rather than a marked field. */
export type IdeaRefusalCode = 'not_active' | 'not_found' | 'not_permitted' | 'failed';

export type IdeaRefusal =
  | { ok: false; code: 'invalid'; issues: IdeaFieldIssue[] }
  | { ok: false; code: IdeaRefusalCode };

/** A save or a retire answers the stored idea; a delete answers nothing. */
export type IdeaWriteResult = { ok: true; idea: StaffIdeaDto } | IdeaRefusal;
export type IdeaDeleteResult = { ok: true } | IdeaRefusal;

function revalidate(slug: string) {
  revalidatePath('/admin/ideas');
  revalidatePath(`/admin/ideas/${slug}`);
}

/** zod's path (`['evidence', 1, 'url']`) as the service writes it (`evidence[1].url`). */
function zodField(path: PropertyKey[]): string {
  return path.reduce<string>((out, part) => {
    if (typeof part === 'number') return `${out}[${part}]`;
    return out ? `${out}.${String(part)}` : String(part);
  }, '');
}

function refused(err: unknown, slug: string, act: string): IdeaRefusal {
  if (err instanceof NotPlatformStaffError) return { ok: false, code: 'not_permitted' };
  if (err instanceof InvalidIdeaInputError) {
    return { ok: false, code: 'invalid', issues: err.issues.map((i) => ({ field: i.field })) };
  }
  if (err instanceof UnknownIdeaTagError) {
    return { ok: false, code: 'invalid', issues: err.tags.map((tag) => ({ field: 'tags', tag })) };
  }
  if (err instanceof IdeaNotActiveError) {
    // The page re-reads, so it shows who retired the idea and why.
    revalidate(slug);
    return { ok: false, code: 'not_active' };
  }
  if (err instanceof IdeaNotFoundError) {
    revalidatePath('/admin/ideas');
    return { ok: false, code: 'not_found' };
  }
  console.error(`[admin] idea ${act} failed`, { slug }, err);
  return { ok: false, code: 'failed' };
}

/**
 * Save an edit. `patch` carries only the changed fields (lists replace
 * wholesale), and `reviewed: true` when the form's box was ticked. The body
 * passes the API's own PATCH schema first, so a malformed field is refused
 * with its path before the service is called.
 */
export async function updateIdeaAction(slug: string, patch: IdeaPatch): Promise<IdeaWriteResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const parsed = ideaPatchBodySchema.safeParse(patch);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'invalid',
        issues: parsed.error.issues.map((i) => ({ field: zodField(i.path) })),
      };
    }
    const idea = await ideasAdminService.updateIdea(
      consoleIdeaActor(principal),
      slug,
      parsed.data as IdeaPatch,
    );
    revalidate(slug);
    return { ok: true, idea };
  } catch (err) {
    return refused(err, slug, 'update');
  }
}

/** Retire an active idea with a stated reason. */
export async function retireIdeaAction(slug: string, reason: string): Promise<IdeaWriteResult> {
  try {
    const principal = await requirePlatformStaff('operator');
    const parsed = reasonBodySchema.safeParse({ reason });
    if (!parsed.success) return { ok: false, code: 'invalid', issues: [{ field: 'reason' }] };
    const idea = await ideasAdminService.retireIdea(
      consoleIdeaActor(principal),
      slug,
      parsed.data.reason,
    );
    revalidate(slug);
    return { ok: true, idea };
  } catch (err) {
    return refused(err, slug, 'retire');
  }
}

/** Hard-delete an idea — a superadmin's correction of a mistake. */
export async function deleteIdeaAction(slug: string, reason: string): Promise<IdeaDeleteResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    const parsed = reasonBodySchema.safeParse({ reason });
    if (!parsed.success) return { ok: false, code: 'invalid', issues: [{ field: 'reason' }] };
    await ideasAdminService.deleteIdea(consoleIdeaActor(principal), slug, parsed.data.reason);
    revalidatePath('/admin/ideas');
    return { ok: true };
  } catch (err) {
    return refused(err, slug, 'delete');
  }
}
