// WHAT A PLAN IS FOR, IN WORDS — ONE rule, both lists that show plans (design
// `design/ai-planning/design-notes.md` Part XXII §22.3, DECIDED; composed on a
// second list by `design/workbench/design-notes.md` § 36.4, MOTIR-7831).
//
// It was `planSentenceOf` inside `components/approvals/ApprovalRow.tsx` and is
// lifted here unchanged, because the Workbench's Planning tab names the SAME
// plans the To-approve row names — one before it is proposed, one after — and two
// copies of this rule is two ways to name one plan. Pure, framework-free: the
// To-approve row is a client component, the Planning row is another, and a server
// renderer could call it too.
//
// ⚠️ A TARGET WHOSE TITLE NO LONGER RESOLVES CANNOT NAME THE PLAN, and the row
// never prints a bare key as a title — so the form FALLS to the next one (the
// plan's own title, then its project) rather than printing a blank. The key cell
// still names the keys the plan targets; that is a different cell and a different
// fact.

/** The naming inputs both rows carry — `PlanApprovalSubjectSummaryDTO` and
 *  `WorkbenchPlanningRowDto` each satisfy this structurally. */
export interface PlanSentenceSubject {
  /** The session's targets in stored order; `title` null when the key no longer resolves. */
  targets: readonly { key: string; title: string | null }[];
  /** `Plan.title`, as written, or null. */
  title: string | null;
  /** The plan's project — the last fallback, so the sentence is never empty. */
  projectName: string;
}

/**
 * The three forms, each ONE ICU message (`approvalGate.planApproval.row.*`), so
 * the word ORDER is the catalogue's — zh puts the title first:
 *   · `targeted`   → *Plan for {target title}* — the title is the quick-view door;
 *   · `untargeted` → *Plan — {plan title}* — plain text, a plan has no quick view;
 *   · `untitled`   → *Plan for {project name}*.
 */
export type PlanSentence =
  | { form: 'targeted'; name: string; key: string }
  | { form: 'untargeted'; name: string }
  | { form: 'untitled'; name: string };

/** Which form this plan's leading line takes, and the name it carries. */
export function planSentenceOf(subject: PlanSentenceSubject): PlanSentence {
  const first = subject.targets[0];
  if (first && first.title) return { form: 'targeted', name: first.title, key: first.key };
  if (subject.title) return { form: 'untargeted', name: subject.title };
  return { form: 'untitled', name: subject.projectName };
}
