import type { ApprovalGate, Prisma } from '@/generated/prisma/client';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';

// AN ACCEPTANCE SENT BACK, STILL STANDING (Story MOTIR-6071 · MOTIR-6502;
// `docs/decisions/acceptance-refusal-verdict.md` §3–§4).
//
// A refusal of a story's acceptance video STANDS while it is still the latest word on
// the story's CURRENT receipt. A newer receipt — the recording `motir fix` publishes
// after a Re-run — asks the question again, and from then on the old refusal is
// history: the new video is what a person watches next. Two readers ask this:
//
//   · the REPAIR claim — a standing Re-run (`revise`, pressed in Motir) is a repair
//     class of its own, `acceptance_rerun`, served by `motir fix <story>`;
//   · the MERGE hold — while any story-run refusal stands, the story's merge is not
//     asked on its own (`acceptance-refusal-verdict.md` §3, MOTIR-6503).
//
// The rule is ONE pure function over three facts, so the two readers cannot drift:
// the latest DECIDED acceptance gate, the story's current receipt, and whether an
// acceptance question is awaiting right now.

/** The refusal a Re-run hands its agent — what the reviewer said, who, and when. */
export interface StandingAcceptanceRefusal {
  gateId: string;
  /** The reviewer's reason, verbatim — required on a Motir press (§10a). */
  reasonMd: string | null;
  decidedByLabel: string | null;
  decidedAt: Date;
}

/**
 * Whether `latest` — the story's most recent DECIDED `acceptance_result` gate — is a
 * refusal that still stands. Null when there is none, when it is not a refusal, when
 * it was about a receipt that is no longer current, or while an acceptance question
 * is awaiting (a republished receipt has asked again).
 */
export function standingAcceptanceRefusalOf(input: {
  latest: ApprovalGate | null;
  currentReceiptId: string | null;
  awaitingAcceptance: boolean;
}): ApprovalGate | null {
  const { latest } = input;
  if (latest === null || latest.state !== 'changes_requested') return null;
  if (input.awaitingAcceptance) return null;
  // The refusal was about THAT recording. Once another is current, it answers nothing.
  if (latest.subjectId !== input.currentReceiptId) return null;
  return latest;
}

/** The three facts {@link standingAcceptanceRefusalOf} reads, in the caller's transaction. */
export async function readStandingAcceptanceRefusal(
  storyId: string,
  tx: Prisma.TransactionClient,
): Promise<ApprovalGate | null> {
  const [latest, current, awaiting] = await Promise.all([
    approvalGateRepository.findLatestDecidedByWorkItemAndKind(storyId, 'acceptance_result', tx),
    acceptanceEvidenceRepository.findCurrentByWorkItem(storyId, tx),
    approvalGateRepository.findAwaitingByWorkItem(storyId, tx),
  ]);
  return standingAcceptanceRefusalOf({
    latest,
    currentReceiptId: current?.id ?? null,
    awaitingAcceptance: awaiting.some((gate) => gate.kind === 'acceptance_result'),
  });
}

/**
 * THE ACCEPTANCE RE-RUN CLASS (§4) — a standing refusal pressed IN MOTIR with the
 * verdict `revise`. A Re-plan is the planner's; a GitHub refusal carries no verdict and
 * admits no repair; a finished story's refusal carries none either.
 */
export async function readAcceptanceRerun(
  storyId: string,
  tx: Prisma.TransactionClient,
): Promise<StandingAcceptanceRefusal | null> {
  const standing = await readStandingAcceptanceRefusal(storyId, tx);
  if (
    standing === null ||
    standing.decisionSource === 'github' ||
    standing.refusalVerdict !== 'revise' ||
    standing.decidedAt === null
  ) {
    return null;
  }
  return {
    gateId: standing.id,
    reasonMd: standing.noteMd,
    decidedByLabel: standing.decidedByLabel,
    decidedAt: standing.decidedAt,
  };
}
