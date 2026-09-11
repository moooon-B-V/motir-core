import type { ApprovalGateKind, Prisma } from '@/generated/prisma/client';
import type {
  ApprovalGateSubjectSummaryDTO,
  DesignResultSubjectSummaryDTO,
  UnregisteredSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';
import type { RegisteredGateKind, UnregisteredGateKind } from '@/lib/approvalGates/registry';
import { isRegisteredGateKind } from '@/lib/approvalGates/registry';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';

// THE SUBJECT SUMMARY — what a QUEUE ROW says about the thing being decided,
// resolved per KIND (Story MOTIR-4879 · Subtask MOTIR-4791; ADR
// docs/decisions/approval-gates.md §1).
//
// ⚠️ WHY THIS IS NOT A METHOD ON `GateHandler`. The registry's handler contract
// is about DECIDING one gate: every one of its seams takes `GateEffectArgs`,
// which carries the locked gate row and a resolved status key, and
// `resolveSubject` is documented to read *the exact version the reviewer is
// looking at*. A queue renders up to a page of gates and decides none of them,
// so routing it through that contract would mean N calls built out of args that
// only a decision has — and it would widen an interface MOTIR-4790 deliberately
// kept to the five things ADR §1's table asks of a kind. This card registers no
// kind and writes no handler; it adds the read's own per-kind seam beside the
// registry, keyed on the registry's own type.
//
// ⚠️ THE SAME COMPILE-TIME GUARANTEE, THOUGH, AND IT IS THE POINT OF THE FILE.
// `SUMMARY_LOADERS` is a `Record<RegisteredGateKind, …>`, so PROMOTING a kind
// fails the build until its summariser exists — exactly as
// `APPROVAL_GATE_HANDLERS` does for its handler. And `_SummaryIsTotal` below
// asserts the DTO union covers the whole Prisma enum, so ADDING a fifth member
// fails the build here too. The read's DTO is therefore total over the enum
// rather than over the kinds that happen to be built, which is the story's own
// criterion.
//
// ⚠️ AND THE ASSERTIONS LIVE HERE RATHER THAN IN `lib/dto/approvalGate.ts`
// BECAUSE OF THE CLIENT/SERVER BOUNDARY. That file is imported by the approval
// frame, a `'use client'` module, and `tests/planning/planChangeArchitecture.test.ts`
// refuses a client module importing the service layer — which is what pulling
// the registry (and through it `designResultHandler` → `workItemsService`) into
// the DTO would be. The types are declared where a client may read them and
// PROVED where the enum is legal to import.

/** The DTO union covers the Prisma enum EXACTLY — a fifth member fails here. */
type _SummaryIsTotal = AssertEqual<ApprovalGateSubjectSummaryDTO['kind'], ApprovalGateKind>;

/** The not-built-yet arm names exactly the registry's declared holes. */
type _UnregisteredArmMatchesRegistry = AssertEqual<
  UnregisteredSubjectSummaryDTO['kind'],
  UnregisteredGateKind
>;

/** Structural equality of two types, as a compile-time assertion — the same
 *  helper `registry.ts` uses, and for the same reason. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : { ERROR: 'approval-gate subject summaries are not total over the kind enum'; A: A; B: B };

/**
 * Load the summaries for one page's worth of subjects of ONE kind, in ONE round
 * trip, keyed by `subjectId`.
 *
 * A subject that no longer resolves is ABSENT from the map rather than mapped to
 * a placeholder — the caller decides what a row with an unresolvable subject
 * says, and that is a rendering decision rather than a data one.
 */
type SummaryLoader = (
  subjectIds: string[],
  tx: Prisma.TransactionClient,
) => Promise<Map<string, ApprovalGateSubjectSummaryDTO>>;

/** How much of a design note a ROW carries. A lead, not the note. */
const NOTE_EXCERPT_CHARS = 180;

/**
 * The first readable line of a design note, flattened.
 *
 * Markdown heading marks, emphasis and list bullets are stripped rather than
 * rendered, because a row is one line of plain text — a `##` arriving verbatim
 * in a list is the tell of a note excerpted by `slice` alone. Returns null for a
 * note that is absent or has no prose in it, which the DTO is honest about.
 */
export function excerptNote(noteMd: string | null): string | null {
  if (noteMd === null) return null;
  const flattened = noteMd
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) return null;
  if (flattened.length <= NOTE_EXCERPT_CHARS) return flattened;
  return `${flattened.slice(0, NOTE_EXCERPT_CHARS).trimEnd()}…`;
}

/**
 * THE LOADERS, total over {@link RegisteredGateKind}.
 *
 * One entry per kind this build can render. Promoting a kind into
 * `RegisteredGateKind` is a missing-property error here until somebody writes
 * its loader — the same sentence the handler registry enforces, one layer over.
 */
const SUMMARY_LOADERS: Record<RegisteredGateKind, SummaryLoader> = {
  async design_result(subjectIds, tx) {
    const rows = await designEvidenceRepository.findManyByIds(subjectIds, tx);
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const [id, row] of rows) {
      const summary: DesignResultSubjectSummaryDTO = {
        kind: 'design_result',
        designEvidenceId: row.id,
        producedByKey: row.producedByKey,
        commitSha: row.commitSha,
        assetCount: row._count.assets,
        noteExcerpt: excerptNote(row.noteMd),
      };
      out.set(id, summary);
    }
    return out;
  },
};

/**
 * Summarise every gate on one page, grouped by kind — **one query per KIND
 * present, never one per gate.**
 *
 * ⚠️ AN UNREGISTERED KIND NEEDS NO QUERY AND GETS NO LOADER. Its summary is the
 * kind itself: there is nothing in this build that knows how to read its
 * subject, which is precisely what the row has to say. Routing it through a
 * loader would mean inventing a read for a kind whose owning card has not
 * shipped one.
 *
 * Returns a map keyed by GATE id — not by subject id — because two gates of
 * different kinds may legitimately carry the same opaque `subjectId`, and the
 * caller is holding gates.
 */
export async function summarizeGateSubjects(
  gates: readonly { id: string; kind: ApprovalGateKind; subjectId: string }[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, ApprovalGateSubjectSummaryDTO | null>> {
  const byKind = new Map<RegisteredGateKind, string[]>();
  for (const gate of gates) {
    if (!isRegisteredGateKind(gate.kind)) continue;
    const bucket = byKind.get(gate.kind);
    if (bucket) bucket.push(gate.subjectId);
    else byKind.set(gate.kind, [gate.subjectId]);
  }

  const loaded = new Map<RegisteredGateKind, Map<string, ApprovalGateSubjectSummaryDTO>>();
  for (const [kind, subjectIds] of byKind) {
    loaded.set(kind, await SUMMARY_LOADERS[kind](subjectIds, tx));
  }

  const out = new Map<string, ApprovalGateSubjectSummaryDTO | null>();
  for (const gate of gates) {
    if (!isRegisteredGateKind(gate.kind)) {
      // The not-built-yet row. The kind is the whole summary, and it is a real
      // answer rather than a missing one.
      out.set(gate.id, { kind: gate.kind } satisfies UnregisteredSubjectSummaryDTO);
      continue;
    }
    // Null when the subject no longer resolves — the loader omits it, and the
    // row says so rather than pretending it read something.
    out.set(gate.id, loaded.get(gate.kind)?.get(gate.subjectId) ?? null);
  }
  return out;
}
