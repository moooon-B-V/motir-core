import { NextResponse } from 'next/server';
import type { ZodError, ZodType, z } from 'zod';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import {
  IdeaNotActiveError,
  IdeaNotFoundError,
  IdeaSlugTakenError,
  IdeaTagTakenError,
  InvalidIdeaFilterError,
  InvalidIdeaInputError,
  UnknownIdeaTagError,
} from './errors';

/**
 * The STAFF ideas routes' transport helpers (Story MOTIR-7662 · MOTIR-7675):
 * one error map, total over everything the gate and `ideasAdminService` throw,
 * and one body/query parser — so eleven handlers cannot drift apart on a status
 * code. Every response carries `Cache-Control: no-store`: these are a staff
 * member's reads of unpublished data.
 *
 * An error this map does not know is RE-THROWN, so Next answers 500 and the
 * defect is visible rather than disguised as a 4xx.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function ideasJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** A malformed request, before any service is called. */
class BadIdeasRequest extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super('Invalid request');
  }
}

function zodIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Parse a JSON body against `schema`, or throw the 400 the map renders. */
export async function parseIdeasBody<S extends ZodType>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadIdeasRequest([{ path: '', message: 'body must be JSON' }]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadIdeasRequest(zodIssues(parsed.error));
  return parsed.data;
}

/** Parse a URL's search params against `schema` (repeated keys keep their last value). */
export function parseIdeasQuery<S extends ZodType>(req: Request, schema: S): z.infer<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new BadIdeasRequest(zodIssues(parsed.error));
  return parsed.data;
}

/** Map a thrown error to its response, or re-throw it. */
export function ideasErrorResponse(err: unknown): NextResponse {
  if (err instanceof NotPlatformStaffError) return ideasJson({ code: 'NOT_FOUND' }, 404);
  if (err instanceof BadIdeasRequest) {
    return ideasJson({ code: 'INVALID_REQUEST', issues: err.issues }, 400);
  }
  if (err instanceof InvalidIdeaInputError) {
    return ideasJson({ code: err.code, issues: err.issues }, 400);
  }
  if (err instanceof InvalidIdeaFilterError) {
    return ideasJson({ code: err.code, field: err.field }, 400);
  }
  if (err instanceof UnknownIdeaTagError) return ideasJson({ code: err.code, tags: err.tags }, 400);
  if (err instanceof IdeaNotFoundError) return ideasJson({ code: err.code }, 404);
  if (err instanceof IdeaSlugTakenError)
    return ideasJson({ code: err.code, slugs: err.slugs }, 409);
  if (err instanceof IdeaNotActiveError) return ideasJson({ code: err.code }, 409);
  if (err instanceof IdeaTagTakenError) return ideasJson({ code: err.code, slug: err.slug }, 409);
  throw err;
}
