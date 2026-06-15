'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectsService } from '@/lib/services/projectsService';
import {
  AliasNotFoundError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAvatarError,
  InvalidIdentifierError,
  InvalidProjectNameError,
  NotProjectAdminError,
  ProjectNotFoundError,
  ProjectOverviewTooLongError,
} from '@/lib/projects/errors';
import type { ProjectDTO } from '@/lib/dto/projects';

// Server Actions for the editable project Details page (Story 6.8 · Subtask
// 6.8.4). Transport only (per CLAUDE.md, Server Actions are the route-layer
// equivalent): resolve session + active project, call ONE service method, and
// translate the typed error into a discriminated RESULT the client maps to its
// i18n string. The service owns the transaction, RLS context, and the
// admin gate — so a non-admin POSTing these directly still fails server-side
// (the UI hide is presentation; the service is the gate).
//
// Why results carry a `code` (not a translated message, unlike the workflow
// actions): the change-key modal renders DISTINCT copy per failure cause — a
// live-key collision vs a reserved-alias collision have distinct remedies — and
// the wording lives ONCE in the `settings.details` i18n catalog (the design
// contract: "the route returns the typed code; 6.8.4 maps code → the string").

interface ResolvedContext {
  userId: string;
  workspaceId: string;
  key: string;
}

async function requireProjectContext(): Promise<ResolvedContext> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, key: ctx.project.identifier };
}

// ── updateDetails (name + avatar — the save bar) ─────────────────────────────

export type UpdateDetailsResult =
  | { ok: true; project: ProjectDTO }
  | { ok: false; code: 'INVALID_NAME' | 'INVALID_AVATAR' | 'NOT_ADMIN' | 'UNKNOWN' };

export interface UpdateProjectDetailsInput {
  name?: string;
  /** `null` clears the avatar (the "None" choice); omit to leave unchanged. */
  avatarIcon?: string | null;
  avatarColor?: string | null;
}

export async function updateProjectDetailsAction(
  input: UpdateProjectDetailsInput,
): Promise<UpdateDetailsResult> {
  const { userId, workspaceId, key } = await requireProjectContext();
  try {
    const project = await projectsService.updateDetails({
      key,
      ctx: { userId, workspaceId },
      name: input.name,
      avatarIcon: input.avatarIcon,
      avatarColor: input.avatarColor,
    });
    return { ok: true, project };
  } catch (err) {
    if (err instanceof InvalidProjectNameError) return { ok: false, code: 'INVALID_NAME' };
    if (err instanceof InvalidAvatarError) return { ok: false, code: 'INVALID_AVATAR' };
    if (err instanceof NotProjectAdminError) return { ok: false, code: 'NOT_ADMIN' };
    if (err instanceof ProjectNotFoundError) return { ok: false, code: 'UNKNOWN' };
    throw err;
  }
}

// ── updateOverview (the public Overview/README authoring view, 6.12.8) ───────

export type UpdateOverviewResult =
  | { ok: true; project: ProjectDTO }
  | { ok: false; code: 'TOO_LONG' | 'NOT_ADMIN' | 'UNKNOWN' };

export interface UpdateProjectOverviewInput {
  /** The full public Overview/README Markdown body; empty clears it. */
  publicOverviewMd: string;
}

export async function updateProjectOverviewAction(
  input: UpdateProjectOverviewInput,
): Promise<UpdateOverviewResult> {
  const { userId, workspaceId, key } = await requireProjectContext();
  try {
    const project = await projectsService.setPublicOverview({
      key,
      ctx: { userId, workspaceId },
      publicOverviewMd: input.publicOverviewMd,
    });
    return { ok: true, project };
  } catch (err) {
    if (err instanceof ProjectOverviewTooLongError) return { ok: false, code: 'TOO_LONG' };
    if (err instanceof NotProjectAdminError) return { ok: false, code: 'NOT_ADMIN' };
    if (err instanceof ProjectNotFoundError) return { ok: false, code: 'UNKNOWN' };
    throw err;
  }
}

// ── changeKey (the guarded modal flow) ───────────────────────────────────────

export type ChangeKeyResult =
  | { ok: true; project: ProjectDTO }
  | {
      ok: false;
      code:
        | 'INVALID_IDENTIFIER'
        | 'IDENTIFIER_TAKEN'
        | 'IDENTIFIER_RESERVED'
        | 'IDENTIFIER_UNCHANGED'
        | 'NOT_ADMIN'
        | 'UNKNOWN';
    };

export async function changeProjectKeyAction(newKey: string): Promise<ChangeKeyResult> {
  const { userId, workspaceId, key } = await requireProjectContext();
  try {
    const project = await projectsService.changeKey({ key, newKey, ctx: { userId, workspaceId } });
    return { ok: true, project };
  } catch (err) {
    if (err instanceof InvalidIdentifierError) return { ok: false, code: 'INVALID_IDENTIFIER' };
    if (err instanceof IdentifierTakenError) return { ok: false, code: 'IDENTIFIER_TAKEN' };
    if (err instanceof IdentifierReservedError) return { ok: false, code: 'IDENTIFIER_RESERVED' };
    if (err instanceof IdentifierUnchangedError) return { ok: false, code: 'IDENTIFIER_UNCHANGED' };
    if (err instanceof NotProjectAdminError) return { ok: false, code: 'NOT_ADMIN' };
    if (err instanceof ProjectNotFoundError) return { ok: false, code: 'UNKNOWN' };
    throw err;
  }
}

// ── releaseAlias (the Previous-keys "Release" confirm) ───────────────────────

export type ReleaseAliasResult =
  | { ok: true; project: ProjectDTO }
  | { ok: false; code: 'ALIAS_NOT_FOUND' | 'NOT_ADMIN' | 'UNKNOWN' };

export async function releaseProjectKeyAction(alias: string): Promise<ReleaseAliasResult> {
  const { userId, workspaceId, key } = await requireProjectContext();
  try {
    const project = await projectsService.releaseAlias({
      key,
      alias,
      ctx: { userId, workspaceId },
    });
    return { ok: true, project };
  } catch (err) {
    if (err instanceof AliasNotFoundError) return { ok: false, code: 'ALIAS_NOT_FOUND' };
    if (err instanceof NotProjectAdminError) return { ok: false, code: 'NOT_ADMIN' };
    if (err instanceof ProjectNotFoundError) return { ok: false, code: 'UNKNOWN' };
    throw err;
  }
}
