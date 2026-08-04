import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentProject } from '@/lib/api/v1/projects/schema';
import { projectsService } from '@/lib/services/projectsService';

// GET /api/v1/projects/{projectKey} (Story 11.3 · Subtask 11.3.3 — MOTIR-2060)
// — one project, by the key every other path in the API already takes.
//
// ── `getByKey`, NOT `getDetails` — a recorded trade ─────────────────────────
// The two return the SAME `ProjectDTO` type with DIFFERENT fields populated,
// which is exactly the kind of difference a spread would hide:
//
//   • `getDetails` loads `createdAt` + `previousKeys`, and resolves LIVE keys
//     only (`resolveProjectByKeyInTx` is alias-blind on purpose — the admin
//     write path must not follow a retired key).
//   • `getByKey` is ALIAS-AWARE (`resolveByKey` → `resolveProjectByKeyWithAliasInTx`)
//     and loads neither.
//
// `getByKey` wins because CONSISTENCY across the API is worth more than two
// descriptive fields. Every other project-scoped v1 path resolves through
// `getByKey` — the work-item collection, and every endpoint 11.3 adds after this
// one. Had this route used `getDetails`, a client's saved key would keep working
// on `…/{key}/work-items` and 404 here after a key change: an API disagreeing
// with itself about whether a project exists.
//
// The two fields are therefore NOT on the v1 project resource, recorded in the
// schema module. Adding them later is additive under §8 and needs an alias-aware
// details read — a card in the owning epic, not something v1 invents at the edge
// (§9's corollary).
//
// ── 404, never 403 ──────────────────────────────────────────────────────────
// Both refusals arrive as the service's own `ProjectNotFoundError`, mapped to
// 404 by the shipped `DOMAIN_ERROR_STATUS`: a key in ANOTHER workspace (the read
// is workspace-scoped, so it simply finds nothing) and a key in THIS workspace
// the caller may not browse (`assertCanBrowse` raises `ProjectAccessDeniedError`
// → also 404). Different code paths, deliberately indistinguishable answers —
// otherwise the endpoint becomes an oracle for which project keys are real.
export const GET = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  return NextResponse.json(presentProject(project));
});
