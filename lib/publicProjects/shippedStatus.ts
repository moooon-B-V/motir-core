/**
 * The default terminal "cancelled" status key — the ONE `done`-category status
 * that is NOT shipped, and therefore never appears on a public surface.
 *
 * `cancelled` is `category: 'done'` in `lib/workflows/defaultWorkflow.ts` (a
 * resolved "won't do / duplicate"), which is correct for every RESOLUTION
 * measure — the reports in `workItemRevisionRepository` count it, and should.
 * It is wrong for every SHIPPED statement: a cancelled item is
 * sealed-not-shipped, so the public roadmap's Done column has excluded it since
 * 6.12.7 and the public CHANGELOG (8.9.3) excludes it for the same reason. A
 * changelog entry that announces cancelled work is a false public claim, and it
 * is the kind of falsehood a feed reader keeps.
 *
 * It is a PROTECTED default key — it cannot be renamed or recategorised
 * (`defaultWorkflow.ts`) — so the literal is stable. A project's CUSTOM
 * done-category statuses still count as shipped; no project-specific "is this a
 * cancel?" detection is attempted, which is the same call the roadmap made.
 *
 * Lives here rather than in either consumer so that the roadmap read
 * (`publicProjectsService`) and the changelog read
 * (`workItemRepository.findPublicChangelogEntries`) share ONE literal. Two
 * copies of a public-truth predicate is exactly how a surface drifts into
 * saying something the other does not.
 */
export const PUBLIC_NOT_SHIPPED_DONE_KEY = 'cancelled';
