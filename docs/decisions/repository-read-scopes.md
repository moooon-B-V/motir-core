# Repository read scopes

Status: accepted 2026-09-09 (MOTIR-4955)

Motir has two product scopes for repository reads:

- **Organisation** — repositories connected to the organisation, used by the
  organisation Git inventory, picker, connection lifecycle, indexing and
  offboarding operations.
- **Project** — repositories explicitly associated through
  `project_repository`, used wherever Motir reads, plans, audits or dispatches
  work for one project.

`github_repo.workspace_id` remains unchanged. It records the workspace that
connected the organisation asset and remains an RLS/operation key; it does not
grant every project in that workspace access to the repository.

## Consumer inventory

| Read / surface                                                           | Scope                                                 | Source and rule                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Organisation Git inventory, picker, disconnect and index status          | Organisation                                          | `github_repo` under an organisation-bound read                                                     |
| “Used by N projects” and disconnect project list                         | Organisation → project links                          | inverse of `project_repository`, access-filtered per project workspace                             |
| Project Repositories room and Code access empty state                    | Project                                               | `project_repository`; no workspace-connected section                                               |
| Work-item authoring, target validation and agent dispatch                | Project                                               | established/project-planned rows from `project_repository`                                         |
| Code-context page and planning freshness                                 | Project                                               | `codeContextService` joins project rows to graph facts                                             |
| Code Health re-audit and convention derivation                           | Project                                               | `resolveProjectCodeContext`; unlinked repositories never enter the submitted envelope              |
| Audit-coverage nudge, onboarding reading state and fresh convention gate | Organisation operation                                | observe connected/indexed substrate; they do not authorize a repository read or dispatch           |
| GitHub/GitLab installation sync, webhook refresh and offboarding         | Organisation operation                                | installation/organisation inventory; not a project membership read                                 |
| Migrate-onboarding connect/index transition                              | Organisation operation with a recorded project choice | the selected `connectedRepoRef` is backfilled into a project link before project reads narrow      |
| Planner generation/routing compatibility                                 | Existing planning contract                            | unchanged in this card; `resolvePlanningCodeContext` remains its dedicated seam                    |
| Prose repository-straddle advisory                                       | Workspace batch heuristic                             | unchanged: it scans a multi-project workspace batch and does not authorize a repo read or dispatch |

## Rollout order

1. Expand: materialise explicit project links from durable project evidence —
   work-item repository pins and `migrate_onboarding.connected_repo_ref`. Reuse a
   matching planned row where one exists; otherwise create a connected `other`
   row. Matching is organisation-bounded; bare legacy names stay within their
   original workspace, while an explicit `owner/name` may resolve org-wide.
2. Verify: report unresolved legacy work-item pins in the migration log. The
   migration is idempotent and never changes `github_repo.workspace_id` or RLS.
3. Contract: make the effective domain project-only; switch Code Health re-audit
   to project context; make “Used by” the inverse of explicit links.
4. Refuse safely: a project with no links reaches nothing. An unresolved legacy
   target therefore fails validation/dispatch instead of silently reaching a
   sibling repository.

This order ensures enforcement does not make every currently evidenced dispatch
target invalid merely because the old association table was empty.
