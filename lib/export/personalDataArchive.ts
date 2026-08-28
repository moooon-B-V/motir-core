import 'server-only';

import { zipSync, strToU8 } from 'fflate';
import { getPrivateBlobBytes } from '@/lib/blob/uploader';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import {
  PERSONAL_DATA_SECTIONS,
  readSection,
  sectionsForTier,
  type PersonalDataSection,
} from './personalDataSections';

// BUILDING THE ARCHIVE (Story 8.4 · Subtask MOTIR-3701 · design DECISION 1).
//
// `motir-export-<date>.zip`, holding one JSON document per table plus the
// reader's own uploaded files under `files/`, which the JSON references by that
// path. The format is the compliance argument, not a layout choice: Art. 15
// (access) is satisfied by almost any readable dump, Art. 20 (portability) only
// by "a structured, commonly used and machine-readable format". JSON-plus-files
// in a zip answers both; a PDF answers one and looks like it answered two.
//
// ⚠️ THE SCOPE RULE IS ENFORCED BY POSTGRES, NOT BY THIS FILE. Every read below
// runs inside the EXPORTING USER's own context — `withUserContext` for the
// identity tier, `withWorkspaceContext` once per workspace they are a member of
// for the tenant tier. A row they could not read in the product is not filtered
// out here; it is never returned. That is what makes "an export is not a
// privilege escalation" a property of the system rather than a promise about
// this function, and it is why the workspace LIST is itself read under the
// user's context rather than passed in.
//
// ⚠️ IN-MEMORY BY CONSTRUCTION, and deliberately so for now. `zipSync` builds
// the whole archive in memory, which is the same bound `putPrivateAttachment`
// already imposes — it takes a Buffer, so the finished archive has to be
// resident whatever the zip library does. Streaming both halves is a real
// improvement and a real change (a streaming zip writer plus a multipart
// upload); it is not a thing to half-do here, and the sizes this ships against
// are a personal account's own rows. `ARCHIVE_SOFT_LIMIT_BYTES` is the tripwire
// that turns "we outgrew this" into a failed row with a reason instead of an
// out-of-memory worker.

/** The archive's own filename, as the reader receives it. */
export function archiveFilename(builtAt: Date): string {
  const date = builtAt.toISOString().slice(0, 10);
  return `motir-export-${date}.zip`;
}

/**
 * Where an attachment's bytes sit inside the archive. The JSON row references
 * the file by exactly this path, which is the "references them by path" half of
 * DECISION 1 — a reader (or a receiving product, under Art. 20) can join the
 * two without guessing a naming convention.
 *
 * The attachment id prefixes the original filename because original filenames
 * are not unique — two work items may both carry `screenshot.png`, and an
 * archive that silently overwrote one would be a quiet data loss inside a
 * feature whose entire purpose is completeness.
 */
export function attachmentArchivePath(attachmentId: string, originalFilename: string): string {
  const safe = originalFilename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  return `files/${attachmentId}-${safe}`;
}

/** Above this, the build fails with a reason rather than exhausting the worker. */
export const ARCHIVE_SOFT_LIMIT_BYTES = 512 * 1024 * 1024;

export class ArchiveTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `Personal-data archive would exceed ${ARCHIVE_SOFT_LIMIT_BYTES} bytes (${bytes}). ` +
        'The build is in-memory; this account needs the streaming path.',
    );
    this.name = 'ArchiveTooLargeError';
  }
}

/** One attachment row, as far as packaging its bytes is concerned. */
interface AttachmentRow {
  id: string;
  blobPathname: string;
  originalFilename: string;
}

function isAttachmentRow(row: unknown): row is AttachmentRow {
  const r = row as AttachmentRow;
  return (
    typeof r?.id === 'string' &&
    typeof r?.blobPathname === 'string' &&
    typeof r?.originalFilename === 'string'
  );
}

export interface BuiltArchive {
  bytes: Buffer;
  /** Row counts per table — the build's own summary, persisted on the job run. */
  counts: Record<string, number>;
  /** How many attachment blobs were packaged, and how many could not be read. */
  files: { packaged: number; missing: number };
}

/**
 * Collect every section for one user, in that user's own database context.
 *
 * The tenant tier is read once PER WORKSPACE and the results concatenated: those
 * tables' RLS policies key on `app.workspace_id`, so one bound workspace admits
 * exactly one workspace's rows. Reading them under a single unbound context
 * would return nothing at all — silently, because RLS answers a denied SELECT
 * with zero rows rather than an error.
 */
export async function collectPersonalData(
  userId: string,
): Promise<{ sections: Map<string, unknown[]>; workspaceIds: string[] }> {
  const sections = new Map<string, unknown[]>();
  for (const section of PERSONAL_DATA_SECTIONS) sections.set(section.table, []);

  // The identity tier, plus the membership list the tenant tier iterates. Both
  // come from the user's own context: `workspace_membership` is armed on
  // `app.user_id`, so this is the same read the product makes for them.
  const workspaceIds = await withUserContext(userId, async (tx) => {
    for (const section of sectionsForTier('identity')) {
      sections.set(section.table, await readSection(section, userId, tx));
    }
    const memberships = (sections.get('workspace_membership') ?? []) as Array<{
      workspaceId?: string;
    }>;
    return [...new Set(memberships.map((m) => m.workspaceId).filter((id): id is string => !!id))];
  });

  const tenantSections = sectionsForTier('tenant');
  for (const workspaceId of workspaceIds) {
    // No `projectId`: the wrapper binds `app.project_id` to the empty string,
    // which is what makes `work_item`'s project-narrowing policy fall through to
    // the WHOLE workspace. Naming a project here would silently narrow the
    // export to one project's work items.
    await withWorkspaceContext({ userId, workspaceId }, async (tx) => {
      for (const section of tenantSections) {
        const rows = await readSection(section, userId, tx);
        if (rows.length) sections.get(section.table)!.push(...rows);
      }
    });
  }

  return { sections, workspaceIds };
}

/**
 * Build the zip for one user. Pure with respect to the database's contents: it
 * reads, it packages, it returns bytes — the row transitions belong to the
 * service, so a failed build cannot half-write a status.
 */
export async function buildPersonalDataArchive(
  userId: string,
  builtAt: Date,
): Promise<BuiltArchive> {
  const { sections, workspaceIds } = await collectPersonalData(userId);

  const files: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  let totalBytes = 0;

  const add = (path: string, bytes: Uint8Array) => {
    totalBytes += bytes.byteLength;
    if (totalBytes > ARCHIVE_SOFT_LIMIT_BYTES) throw new ArchiveTooLargeError(totalBytes);
    files[path] = bytes;
  };

  for (const section of PERSONAL_DATA_SECTIONS) {
    const rows = sections.get(section.table) ?? [];
    counts[section.table] = rows.length;
    add(
      `${section.table}.json`,
      strToU8(JSON.stringify({ table: section.table, basis: section.basis, rows }, null, 2)),
    );
  }

  // The files half. Only attachments the reader UPLOADED, and only those whose
  // row survived their own RLS read above — the row IS the authorization.
  let packaged = 0;
  let missing = 0;
  for (const row of sections.get('attachment') ?? []) {
    if (!isAttachmentRow(row)) continue;
    const bytes = await getPrivateBlobBytes(row.blobPathname);
    if (!bytes) {
      // A row whose object is gone (a GC'd orphan, a failed upload). The
      // manifest records it rather than the archive pretending it shipped.
      missing += 1;
      continue;
    }
    add(attachmentArchivePath(row.id, row.originalFilename), new Uint8Array(bytes));
    packaged += 1;
  }

  add(
    'manifest.json',
    strToU8(
      JSON.stringify(
        {
          format: 'motir-personal-data-export/1',
          builtAt: builtAt.toISOString(),
          userId,
          workspaceIds,
          // The enumeration travels WITH the archive, so a reader can tell an
          // empty section from a table nobody exported without reading our code.
          tables: PERSONAL_DATA_SECTIONS.map((s) => ({
            table: s.table,
            tier: s.tier,
            basis: s.basis,
            rows: counts[s.table] ?? 0,
            redacted: s.redact ?? [],
          })),
          files: { packaged, missing },
        },
        null,
        2,
      ),
    ),
  );

  add('README.txt', strToU8(readme()));

  return { bytes: Buffer.from(zipSync(files)), counts, files: { packaged, missing } };
}

/** The one piece of reader-facing prose in the archive. */
function readme(): string {
  return [
    'Your Motir data export',
    '======================',
    '',
    'This archive is your right of access and your right to portability — one',
    'file serves both.',
    '',
    'Each `<table>.json` holds the records Motir stores for you in that table,',
    'with a short note saying why those rows are yours. `manifest.json` lists',
    'every table in this archive, how many rows each holds, and which columns',
    'were deliberately left out.',
    '',
    'Files you uploaded are under `files/`. The rows in `attachment.json`',
    'reference them by exactly that path.',
    '',
    'Some columns are deliberately absent: password hashes, session tokens,',
    'two-factor secrets and API-token hashes. Those protect your account rather',
    'than describe you, and a copy of them in a downloadable file would weaken',
    'the account this export belongs to.',
    '',
    'This export covers your own account and the workspaces you are a member of,',
    'as far as your access reaches. It does not include other people’s data.',
    '',
    'Questions: privacy@motir.co',
    '',
  ].join('\n');
}

export type { PersonalDataSection };
