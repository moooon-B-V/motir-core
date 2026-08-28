import { Prisma, type WorkItem } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { randomUUID } from 'node:crypto';
import { headPrivateBlob, mintPrivateUploadToken, putPrivateAttachment } from '@/lib/blob/uploader';
import { MAX_UPLOAD_BYTES, isAllowedDesignAssetType } from '@/lib/blob/allowlist';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';
import {
  DesignEvidenceBlobMissingError,
  DesignEvidenceEmptyError,
  DesignEvidenceNotAChildError,
  DesignEvidenceNotALeafError,
  DesignEvidenceNoCurrentResultError,
  DesignEvidenceNotFoundError,
  DesignEvidencePathnameError,
  DesignEvidenceSupersedeConflictError,
} from '@/lib/designEvidence/errors';
import { toDesignEvidenceDto } from '@/lib/mappers/designEvidenceMappers';
import type {
  DesignAssetKindDTO,
  DesignEvidenceDTO,
  DesignUploadTargetDTO,
  DesignUploadTokensDTO,
} from '@/lib/dto/designEvidence';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

/**
 * Design results — business logic (Story MOTIR-2664 · Subtask MOTIR-2666).
 * Owns the register-from-pathnames flow (supersede the prior current + store the
 * new artifacts) and the panel read. Reuses the shipped blob pipeline and the
 * entitlements caps for the bytes.
 *
 * **No eligibility gate.** Unlike acceptance video, a design result is NOT
 * plan-gated or org-toggled — it is tens of kilobytes and reading the design of
 * the work you are reviewing is core project management, not a paid AI feature
 * (docs/decisions/design-result.md §2). Only the mechanical cost bounds apply,
 * and they are enforced here.
 */

/** The inline `noteMd` ceiling — a RENDERING bound, never a data-loss bound. */
export const NOTE_MD_CAP_BYTES = 64 * 1024;

/** The kinds a caller may publish, mirroring the `design_asset_kind` enum. */
const ASSET_KINDS: readonly DesignAssetKindDTO[] = ['mock', 'image', 'note_file'];

export interface DesignAssetInput {
  kind: DesignAssetKindDTO;
  /** The repo path the file came from. */
  sourcePath: string;
  /** The private-store key the client uploaded it to. */
  pathname: string;
}

export interface RecordDesignResultInput {
  /** The work item whose design this is — the card that produced it. */
  workItemId: string;
  assets: DesignAssetInput[];
  /** The extracted `design-notes.md` section text, if the PR changed any. */
  noteMd?: string | null;
  commitSha?: string | null;
  ciRunUrl?: string | null;
  producedByKey?: string | null;
  /**
   * The container whose PARENT-RUN branch this publish belongs to (MOTIR-3177).
   * Present only on that path; it asserts the target is one of that container's
   * children, and is never persisted.
   */
  withinParentKey?: string | null;
}

/**
 * One asset published with its BYTES IN HAND, for the caller that is already
 * inside the server (MOTIR-3782). {@link DesignAssetInput} names a blob the
 * CLIENT has already PUT; this names one nobody has uploaded yet.
 */
export interface DesignAssetBytesInput {
  kind: DesignAssetKindDTO;
  /** The repo path the file came from. */
  sourcePath: string;
  /** The media type the caller declares. Checked here, and again at register
   *  against what the store actually holds. */
  contentType: string;
  /** The decoded file bytes. */
  bytes: Buffer;
}

export interface RecordDesignResultFromBytesInput extends Omit<RecordDesignResultInput, 'assets'> {
  assets: DesignAssetBytesInput[];
}

/** The private-store key prefix that scopes one item's design artifacts. */
export function designPrefix(workspaceId: string, workItemId: string): string {
  return `design/${workspaceId}/${workItemId}/`;
}

/** The last path segment (the stored filename) of a blob pathname. */
function blobFilename(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/** The basename of a repo path, used to keep a stored key recognisable. */
function basenameOf(sourcePath: string): string {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1) || 'asset';
}

/**
 * Kinds that may own a design result. A result belongs to the CARD THAT
 * PRODUCED IT, so a container is refused: a story has many designs, one per
 * design subtask (§3). Deliberately the mirror image of the acceptance path,
 * which rolls a subtask key UP to its story.
 */
const LEAF_KINDS = new Set(['task', 'bug', 'subtask']);

/**
 * ⚠️ LEAF is a position in the tree, not a kind (MOTIR-3146).
 *
 * `LEAF_KINDS` answers *"is this a kind that CAN be a leaf?"*, and only `subtask`
 * makes those two questions the same: `lib/issues/parentRules.ts` has
 * `bug → [subtask]` and `task → [bug, subtask]`, so a `bug` or a `task` may hold
 * children and be a CONTAINER. Reading the kind alone let one through — a
 * `parent/MOTIR-<bug>-…` pull request from the parent-run form, whose branch
 * carries the container's key by design — and the publish proceeded into a 500
 * instead of the clean no-op MOTIR-3124 built for exactly this case.
 *
 * So the check is structural: a target is publishable when it has NO CHILDREN.
 * The kind test stays as the cheap first pass (an `epic` / `story` needs no
 * query); the child read settles the rest.
 */
async function isLeafPosition(item: WorkItem, ctx: ServiceContext): Promise<boolean> {
  if (!LEAF_KINDS.has(item.kind)) return false;
  if (item.kind === 'subtask') return true; // the only kind nothing may parent to
  const children = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findChildren(item.id, tx),
  );
  return children.length === 0;
}

/**
 * A PARENT-RUN publisher declares the container whose branch it is publishing
 * for, and the target must be one of that container's own children (MOTIR-3177).
 *
 * The publisher reads the producing card's key out of a COMMIT SUBJECT, which is
 * prose: a mistyped key resolves to a real, unrelated leaf that would otherwise
 * accept the publish. Only the tenant can see the tree, so only the tenant can
 * refuse. Absent (the ordinary one-card publish, where the branch names the card
 * directly) this check does not run at all.
 *
 * A container key that resolves to nothing is refused for the same reason a
 * non-child is: it is a claim about the tree that the tree does not support.
 */
async function assertChildOf(
  item: WorkItem,
  containerIdentifier: string,
  ctx: ServiceContext,
): Promise<void> {
  const container = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    // Same project by construction: both keys carry the project's prefix, and a
    // cross-project identifier simply does not resolve here.
    (tx) => workItemRepository.findByIdentifier(item.projectId, containerIdentifier, tx),
  );
  if (!container || item.parentId !== container.id) {
    throw new DesignEvidenceNotAChildError(item.identifier, containerIdentifier);
  }
}

/** Resolve + validate the design target is a visible LEAF (RLS-scoped). */
async function resolveTarget(
  workItemId: string,
  ctx: ServiceContext,
  withinParentKey?: string | null,
): Promise<WorkItem> {
  const item = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findById(workItemId, tx),
  );
  if (!item) throw new DesignEvidenceNotFoundError(workItemId);
  if (!(await isLeafPosition(item, ctx))) {
    throw new DesignEvidenceNotALeafError(item.kind, !LEAF_KINDS.has(item.kind));
  }
  if (withinParentKey) await assertChildOf(item, withinParentKey.trim().toUpperCase(), ctx);
  // Attaching a design result to an item is editing that item; the project is
  // resolved from the ITEM, never from the actor's active project (the gate
  // MOTIR-2365 added to the acceptance resolver after a token-minting endpoint
  // turned out to be reachable with a session and an id).
  await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');
  return item;
}

/**
 * Resolve + authorize a WITHDRAWAL target (MOTIR-3215).
 *
 * ⚠️ Deliberately WITHOUT {@link isLeafPosition}, which {@link resolveTarget}
 * applies. The leaf rule belongs to PUBLISH — it decides which card a design
 * result may be attached to (§3). Applying it here would mean a card that has
 * since GAINED a child can no longer have its wrong result taken back, which
 * re-creates the permanence this whole path exists to remove: a `task` or `bug`
 * is leaf-CAPABLE, not leaf-BY-KIND (MOTIR-3146), so an ordinary re-plan is
 * enough to strand a row forever. A row that exists is withdrawable.
 *
 * The item-scoped `work_item:edit` gate is unchanged and is the real authority
 * check: withdrawing a design result is editing that item, and the project is
 * resolved from the ITEM rather than the actor's active project (the same gate
 * MOTIR-2365 put on the acceptance resolver).
 */
async function resolveWithdrawTarget(workItemId: string, ctx: ServiceContext): Promise<WorkItem> {
  const item = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findById(workItemId, tx),
  );
  if (!item) throw new DesignEvidenceNotFoundError(workItemId);
  await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');
  return item;
}

/** The org's per-file byte cap + org id (10 MB baseline off-cloud/unresolved). */
async function resolveCostContext(
  workspaceId: string,
): Promise<{ organizationId: string | null; perFileLimit: number }> {
  const organizationId =
    (
      await withWorkspaceServiceContext(workspaceId, (tx) =>
        workspaceRepository.findById(workspaceId, tx),
      )
    )?.organizationId ?? null;
  const perFileLimit = organizationId
    ? await entitlementsService.resolvePerFileLimitBytes(organizationId)
    : MAX_UPLOAD_BYTES;
  return { organizationId, perFileLimit };
}

/**
 * Cap the inline note at {@link NOTE_MD_CAP_BYTES}, truncating **at a `##`
 * section boundary** so the stored copy is never half a section, and appending a
 * marker naming how many were dropped.
 *
 * Nothing is lost: the publisher always ships the complete text as a `note_file`
 * asset, which is exactly what makes this a rendering bound (§1). The cap exists
 * because `design-notes.md` is written per AREA — the work-items file alone is
 * 303,395 bytes across 29 sections — so an unbounded column would ship a
 * 300 KB document to every page render.
 */
export function capNoteMd(noteMd: string | null | undefined): {
  noteMd: string | null;
  noteTruncated: boolean;
} {
  if (noteMd == null || noteMd === '') return { noteMd: null, noteTruncated: false };
  if (Buffer.byteLength(noteMd, 'utf8') <= NOTE_MD_CAP_BYTES) {
    return { noteMd, noteTruncated: false };
  }

  // Split into `##` sections, keeping any preamble above the first heading as
  // its own leading chunk so a note that starts mid-file is not mangled.
  const lines = noteMd.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));

  const kept: string[] = [];
  let bytes = 0;
  for (const section of sections) {
    const size = Buffer.byteLength(section, 'utf8') + 1; // + the joining newline
    if (bytes + size > NOTE_MD_CAP_BYTES) break;
    kept.push(section);
    bytes += size;
  }

  const dropped = sections.length - kept.length;
  if (kept.length === 0) {
    // A single section larger than the whole cap: keep a prefix of it rather
    // than storing nothing, cut on a character boundary. `sections` always has
    // at least one entry here — the split loop pushes whatever it accumulated.
    const head = Buffer.from(sections[0]!, 'utf8').subarray(0, NOTE_MD_CAP_BYTES).toString('utf8');
    return {
      noteMd: `${head}\n\n---\n\n_Truncated for display — the complete note is published as the \`note_file\` asset._`,
      noteTruncated: true,
    };
  }

  return {
    noteMd: `${kept.join('\n')}\n\n---\n\n_Truncated for display: ${dropped} of ${sections.length} section(s) omitted. The complete note is published as the \`note_file\` asset._`,
    noteTruncated: true,
  };
}

/**
 * Idempotency: a CI redelivery of the SAME commit+producer is a no-op — the
 * current result already records it, so return it (no re-upload, no duplicate
 * history row). Null when there is no matching current result.
 */
async function findIdempotentExisting(
  workItemId: string,
  commitSha: string | null | undefined,
  producedByKey: string | null | undefined,
  ctx: ServiceContext,
): Promise<DesignEvidenceDTO | null> {
  if (!commitSha) return null;
  const existing = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
  );
  return existing &&
    existing.commitSha === commitSha &&
    existing.producedByKey === (producedByKey ?? null)
    ? toDesignEvidenceDto(existing)
    : null;
}

/**
 * Translate a lost supersede race into a typed domain error. The
 * `design_evidence_one_current_per_item` partial-unique index is what makes two
 * current rows unrepresentable, so the loser surfaces as a Prisma `P2002`;
 * letting that escape would leak a raw DB error out of the service (the
 * typed-error rule in CLAUDE.md). Anything else is re-thrown untouched.
 *
 * Extracted so the mapping is unit-testable without having to win a real race.
 */
export function translateSupersedeConflict(err: unknown, workItemId: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new DesignEvidenceSupersedeConflictError(workItemId);
  }
  return err;
}

interface ArtifactMeta extends DesignAssetInput {
  contentType: string;
  size: number;
  filename: string;
}

/**
 * Supersede the prior current result + write the new Attachment / asset /
 * evidence rows, atomically in ONE withWorkspaceContext transaction (which binds
 * the RLS GUC for the publish path, whose caller has no request middleware).
 */
async function persistEvidence(
  args: {
    item: WorkItem;
    artifacts: ArtifactMeta[];
    noteMd: string | null;
    noteTruncated: boolean;
    commitSha: string | null;
    ciRunUrl: string | null;
    producedByKey: string | null;
  },
  ctx: ServiceContext,
) {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    // Lock BEFORE reading what to supersede — the decision is read-derived, so
    // an unlocked read lets two publishes both target the same current row.
    await designEvidenceRepository.lockCurrentByWorkItem(args.item.id, tx);
    const prior = await designEvidenceRepository.findCurrentByWorkItem(args.item.id, tx);
    if (prior) {
      await designEvidenceRepository.markSupersededByWorkItem(args.item.id, tx);
      // Unlink the superseded artifacts so the orphan-GC reclaims their blobs
      // after the safety window (one current result per item).
      const priorAttachmentIds = prior.assets
        .map((a) => a.attachmentId)
        .filter((id): id is string => id !== null);
      if (priorAttachmentIds.length > 0) {
        await attachmentRepository.unlinkFromWorkItem(priorAttachmentIds, tx);
      }
    }

    const evidence = await designEvidenceRepository.create(
      {
        workspaceId: ctx.workspaceId,
        workItemId: args.item.id,
        noteMd: args.noteMd,
        noteTruncated: args.noteTruncated,
        commitSha: args.commitSha,
        ciRunUrl: args.ciRunUrl,
        producedByKey: args.producedByKey,
        isCurrent: true,
      },
      tx,
    );

    let position = 0;
    for (const artifact of args.artifacts) {
      const attachment = await attachmentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          uploaderUserId: ctx.userId,
          workItemId: args.item.id,
          source: 'design_asset',
          blobPathname: artifact.pathname,
          mimeType: artifact.contentType,
          sizeBytes: artifact.size,
          originalFilename: artifact.filename,
        },
        tx,
      );
      await designEvidenceRepository.createAsset(
        {
          workspaceId: ctx.workspaceId,
          designEvidenceId: evidence.id,
          kind: artifact.kind,
          attachmentId: attachment.id,
          sourcePath: artifact.sourcePath,
          position: position++,
        },
        tx,
      );
    }

    // Re-read so the caller gets the evidence WITH its just-inserted assets.
    // Non-null by construction: the row was created in THIS transaction, a few
    // statements above, and nothing between can remove it.
    return (await designEvidenceRepository.findById(evidence.id, tx))!;
  });
}

export const designEvidenceService = {
  /**
   * Mint scoped CLIENT upload grants so a trusted CI job PUTs each design
   * artifact DIRECTLY to the private store, never through the application. Each
   * grant is bound to one exact pathname (under this item's
   * `design/<ws>/<itemId>/` prefix), one content type, and the org's per-file
   * cap. CI then reports the pathnames back via {@link recordFromPathnames}.
   *
   * The declared content type is checked against the design allowlist HERE, so a
   * disallowed type never gets a key minted for it at all — and checked AGAIN at
   * register against what the store actually holds, because a presigned PUT
   * proves what was signed, not what was sent.
   */
  async createUploadTokens(
    input: {
      workItemId: string;
      files: Array<{ kind: DesignAssetKindDTO; sourcePath: string; contentType: string }>;
      /** The container whose parent-run branch this publish belongs to, if any. */
      withinParentKey?: string | null;
    },
    ctx: ServiceContext,
  ): Promise<DesignUploadTokensDTO> {
    const item = await resolveTarget(input.workItemId, ctx, input.withinParentKey);
    if (!input.files || input.files.length === 0) throw new DesignEvidenceEmptyError();

    const { perFileLimit } = await resolveCostContext(ctx.workspaceId);
    const prefix = designPrefix(ctx.workspaceId, item.id);
    const nonce = randomUUID();

    const targets: DesignUploadTargetDTO[] = [];
    for (const [index, file] of input.files.entries()) {
      if (!ASSET_KINDS.includes(file.kind)) {
        throw new UnsupportedFileTypeError(String(file.kind));
      }
      if (!isAllowedDesignAssetType(file.contentType)) {
        throw new UnsupportedFileTypeError(file.contentType);
      }
      // The nonce + index keep two files of the same basename from colliding,
      // and keep a re-publish from overwriting the previous run's objects (the
      // superseded ones are the orphan-GC's to reclaim, not ours to clobber).
      const pathname = `${prefix}${nonce}-${index}-${basenameOf(file.sourcePath)}`;
      targets.push({
        sourcePath: file.sourcePath,
        kind: file.kind,
        pathname,
        token: await mintPrivateUploadToken(pathname, {
          contentType: file.contentType,
          maxBytes: perFileLimit,
        }),
        contentType: file.contentType,
        maxBytes: perFileLimit,
      });
    }
    return { targets };
  },

  /**
   * Register design artifacts already CLIENT-uploaded to the private store,
   * superseding the prior current result. The caller reports only pathnames; the
   * server (a) rejects any pathname OUTSIDE this item's design prefix and
   * (b) `head`s each blob for its AUTHORITATIVE size + contentType — so a lying,
   * cross-tenant or absent pathname can never be recorded, and a mock that
   * DECLARED `image/png` but uploaded HTML is rejected on what the store holds.
   *
   * **Never advances the item's status.** Publishing is evidence, not a workflow
   * decision — holding dependents and asking a human to approve belongs to the
   * runtime design-approval gate (§7).
   */
  async recordFromPathnames(
    input: RecordDesignResultInput,
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO> {
    const item = await resolveTarget(input.workItemId, ctx, input.withinParentKey);

    if (!input.assets || input.assets.length === 0) throw new DesignEvidenceEmptyError();

    const idempotent = await findIdempotentExisting(
      item.id,
      input.commitSha,
      input.producedByKey,
      ctx,
    );
    if (idempotent) return idempotent;

    // SECURITY: every reported pathname MUST live under this item's design
    // prefix (reject an arbitrary or cross-tenant blob before any DB write).
    const prefix = designPrefix(ctx.workspaceId, item.id);
    for (const asset of input.assets) {
      if (!asset.pathname.startsWith(prefix)) {
        throw new DesignEvidencePathnameError(asset.pathname);
      }
      if (!ASSET_KINDS.includes(asset.kind)) {
        throw new UnsupportedFileTypeError(String(asset.kind));
      }
    }

    const { organizationId, perFileLimit } = await resolveCostContext(ctx.workspaceId);

    const artifacts: ArtifactMeta[] = [];
    for (const asset of input.assets) {
      // head() → the blob must EXIST (the client upload completed) and its size
      // + contentType are read from the STORE, never trusted from the caller.
      const head = await headPrivateBlob(asset.pathname);
      if (!head) throw new DesignEvidenceBlobMissingError(asset.pathname);
      if (!isAllowedDesignAssetType(head.contentType)) {
        throw new UnsupportedFileTypeError(head.contentType);
      }
      if (head.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
      if (organizationId) {
        await entitlementsService.assertWithinStorageCap(organizationId, head.size);
      }
      artifacts.push({
        ...asset,
        contentType: head.contentType,
        size: head.size,
        filename: blobFilename(asset.pathname),
      });
    }

    const { noteMd, noteTruncated } = capNoteMd(input.noteMd);

    try {
      const row = await persistEvidence(
        {
          item,
          artifacts,
          noteMd,
          noteTruncated,
          commitSha: input.commitSha ?? null,
          ciRunUrl: input.ciRunUrl ?? null,
          producedByKey: input.producedByKey ?? null,
        },
        ctx,
      );
      return toDesignEvidenceDto(row);
    } catch (err) {
      throw translateSupersedeConflict(err, item.id);
    }
  },

  /**
   * Publish a design result from BYTES THE CALLER ALREADY HOLDS (MOTIR-3782) —
   * the door for an agent inside the server, where the mint-then-PUT dance has
   * nothing to dance with.
   *
   * ⚠️ IT ADDS NO POLICY. Every decision stays where it already lived: the
   * target resolution and its leaf / child refusals are {@link resolveTarget};
   * the pathname is composed exactly as {@link createUploadTokens} composes it,
   * under the same `design/<ws>/<itemId>/` prefix with the same nonce-and-index
   * collision guard; and the whole register half — the prefix check, the
   * authoritative `head`, the storage cap, `capNoteMd`, the `note_file`
   * companion, supersede and idempotency — is {@link recordFromPathnames},
   * called at the end rather than reimplemented. What this method owns is the
   * upload, and nothing else.
   *
   * ⚠️ THE PER-FILE CAP IS CHECKED BEFORE THE WRITE, WHICH THE MINTED PATH
   * CANNOT DO. A presigned PUT is enforced server-side AFTER the object lands
   * (`mintPrivateUploadToken`'s own note), because the grant cannot bound what a
   * client actually sends. Here the bytes are in hand, so an over-cap asset is
   * refused having written nothing — a strictly better outcome reached only
   * because the caller is on this side of the wire. `recordFromPathnames` still
   * re-checks the STORED size, and that check remains the authoritative one.
   *
   * ⚠️ THE DECLARED TYPE IS CHECKED HERE AND THE STORED TYPE AT REGISTER, and
   * both are deliberate. This one refuses a disallowed type before any object
   * exists — the same thing the mint step does for the same reason. The register
   * check reads what the store holds, which is what actually protects §5's
   * one-entrance guarantee for `text/html`.
   */
  async recordFromBytes(
    input: RecordDesignResultFromBytesInput,
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO> {
    const item = await resolveTarget(input.workItemId, ctx, input.withinParentKey);
    if (!input.assets || input.assets.length === 0) throw new DesignEvidenceEmptyError();

    const { perFileLimit } = await resolveCostContext(ctx.workspaceId);
    const prefix = designPrefix(ctx.workspaceId, item.id);
    const nonce = randomUUID();

    const uploaded: DesignAssetInput[] = [];
    for (const [index, asset] of input.assets.entries()) {
      if (!ASSET_KINDS.includes(asset.kind)) {
        throw new UnsupportedFileTypeError(String(asset.kind));
      }
      if (!isAllowedDesignAssetType(asset.contentType)) {
        throw new UnsupportedFileTypeError(asset.contentType);
      }
      if (asset.bytes.byteLength > perFileLimit) throw new FileTooLargeError(perFileLimit);

      // ⚠️ REGISTER THE KEY THE STORE ACTUALLY WROTE, never the one asked for.
      // `putPrivateAttachment` returns the object key, and `putObject` appends a
      // random suffix to it before writing — so the requested pathname names no
      // object, and registering it makes the very next step
      // (`recordFromPathnames`'s authoritative `head`) fail with
      // `DESIGN_EVIDENCE_BLOB_MISSING`. The suffix is still under this item's
      // design prefix, so the prefix check is unaffected.
      const written = await putPrivateAttachment(
        `${prefix}${nonce}-${index}-${basenameOf(asset.sourcePath)}`,
        asset.bytes,
        asset.contentType,
      );
      uploaded.push({
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        pathname: written.pathname,
      });
    }

    // Address the item by ID: it is already resolved, and re-resolving by the
    // caller's original reference would re-run the child gate against a
    // container this call has already cleared.
    return this.recordFromPathnames({ ...input, workItemId: item.id, assets: uploaded }, ctx);
  },

  /**
   * WITHDRAW a work item's CURRENT design result — clear it with NOTHING taking
   * its place (MOTIR-3215).
   *
   * Until this existed the table had exactly two mutations, create and
   * supersede-by-publish, and BOTH need a replacement. A result published onto a
   * card that will never have a design of its own therefore could not be
   * corrected by any means: there is nothing correct to publish over it. That is
   * not a gap somebody failed to fill — it is the reason MOTIR-3213's stray rows
   * were still standing in production days after the publisher was fixed.
   *
   * **Nothing is deleted, and that is settled law in this domain.** The evidence
   * row survives, its `design_asset` rows survive, and their `Attachment` rows
   * are NOT unlinked — unlike a supersede, which hands the old blobs to the
   * orphan-GC because a correct replacement has taken over the record. Here the
   * record IS the point: destroying it would leave no way to see what was
   * wrongly claimed, or that anything was claimed at all. Same position
   * `declinePlan` reached in MOTIR-3154 / MOTIR-3160.
   *
   * **Never advances the item's status**, for the same reason the publish path
   * does not: this is evidence, not a workflow decision.
   */
  async withdrawCurrentForWorkItem(
    input: { workItemId: string; reason?: string | null },
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO> {
    const item = await resolveWithdrawTarget(input.workItemId, ctx);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Lock BEFORE reading which row to withdraw — the decision is
        // read-derived exactly as the supersede's is, so an unlocked read lets a
        // concurrent publish insert a new current row that this withdrawal then
        // silently misses (the lock-before-read-derived-update rule in
        // CLAUDE.md). The lock is what makes "the row I read is the row I write"
        // true here.
        await designEvidenceRepository.lockCurrentByWorkItem(item.id, tx);
        const current = await designEvidenceRepository.findCurrentByWorkItem(item.id, tx);
        if (!current) throw new DesignEvidenceNoCurrentResultError(item.identifier);
        return designEvidenceRepository.withdrawById(
          current.id,
          { withdrawnById: ctx.userId, withdrawnReason: input.reason?.trim() || null },
          tx,
        );
      },
    );
    return toDesignEvidenceDto(row);
  },

  /**
   * The CURRENT design result for a work item — the Design result panel's read.
   * Returns null when nothing has been published (the panel's empty state, which
   * is the normal case for every card that shipped before this feature).
   */
  async getCurrentForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    );
    return row ? toDesignEvidenceDto(row) : null;
  },
};
