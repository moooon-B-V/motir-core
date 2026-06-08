// Parse a work item's context-file references out of its Markdown body
// (Subtask 7.0.2). Prodect's plan model stores a work item's context refs as a
// `## Context refs` sub-section of `descriptionMd` (the body is `description` +
// `## Acceptance criteria` + `## Context refs`, per `scripts/plan-seed/types.ts`)
// — there is NO `contextRefs` column on `work_item` (finding #62; the 7.0.3
// card's "2.1.5 added it" citation is false). The dispatch DTO
// (`ReadyItemDispatchDto.contextRefs`) takes the refs as a service-supplied
// input; this is the function the service supplies, so the BYOK agent gets the
// REAL file paths a subtask names — not an empty array — for the live dogfood
// tenant today.
//
// If a future `contextRefs String[]` column lands (the optional post-GA
// enhancement noted in finding #62), the mapper should PREFER that column and
// fall back to this parse for free-form descriptions that don't follow the
// section convention.

/**
 * Pull the file paths an agent should read out of the body's `## Context refs`
 * section. Every bullet under that heading (until the next heading) contributes
 * one ref: its first backtick-quoted span if present (the file path), else the
 * bullet text up to the first ` — ` / ` - ` separator. Returns `[]` when the
 * body is empty or has no such section. Case-insensitive on the heading;
 * tolerant of `##`/`###` levels.
 */
export function extractContextRefs(md: string | null | undefined): string[] {
  if (!md) return [];
  const refs: string[] = [];
  let inSection = false;
  for (const line of md.split('\n')) {
    const heading = line.match(/^#{2,}\s+(.*)$/);
    if (heading) {
      inSection = /context\s+refs?/i.test(heading[1] ?? '');
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (!bullet) continue;
    const item = (bullet[1] ?? '').trim();
    const backtick = item.match(/`([^`]+)`/);
    const ref = backtick ? (backtick[1] ?? '').trim() : (item.split(/\s[—–-]\s/)[0] ?? '').trim();
    if (ref) refs.push(ref);
  }
  return refs;
}
