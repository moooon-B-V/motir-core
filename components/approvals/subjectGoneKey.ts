import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

// WHICH `subjectGone.<kind>` SENTENCE a gate whose subject no longer resolves takes
// (Bug MOTIR-7146). The row and the overlay both said *"The design…"* for EVERY kind, so a
// gone merge, acceptance or choice question was described as a missing design. Each kind
// now names its own subject, in `workbench.approvals.subjectGone` and
// `approvalOverlay.subjectGone`.
//
// TOTAL over the kind enum, so a new kind is a compile error here until it is given a
// sentence. `pull_request_merge` is unregistered (MOTIR-5616): its rows read *not built
// yet*, never *gone*, so it borrows the merge question's sentence only to stay total.
const SUBJECT_GONE_KEY: Record<ApprovalGateKindDTO, string> = {
  design_result: 'design_result',
  decision_approval: 'decision_approval',
  acceptance_result: 'acceptance_result',
  pull_request_approval: 'pull_request_approval',
  pull_request_merge: 'pull_request_approval',
  decision_choice: 'decision_choice',
  decision_confirmation: 'decision_confirmation',
  plan_approval: 'plan_approval',
  agent_review: 'agent_review',
  manual_work: 'manual_work',
  // A session that stopped waiting is withdrawn `session_ended`, never read as gone, so it
  // borrows the plan question's sentence only to stay total (MOTIR-7913).
  planning_session: 'plan_approval',
};

/** The catalogue key, under `subjectGone.`, for a gone subject of this kind. */
export function subjectGoneKey(kind: ApprovalGateKindDTO): string {
  return `subjectGone.${SUBJECT_GONE_KEY[kind]}`;
}
