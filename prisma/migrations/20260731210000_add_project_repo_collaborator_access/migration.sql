-- MOTIR-1900 — the per-row COLLABORATOR INVITATION on `project_repository`.
--
-- Story MOTIR-1775's amended ADR (`docs/decisions/project-repository-set.md`
-- §3, amendment 2026-07-30) makes every repository Motir creates live in
-- MOTIR's own GitHub org, PRIVATE. The user is not a member of that org, so
-- reversing ownership silently removed the thing that used to be implicit:
-- the ability to clone your own code. Motir therefore invites the approving
-- user's GitHub account as an ADMIN collaborator on each repository it makes,
-- and these four columns are the record of that invitation.
--
-- WHY FOUR NULLABLE COLUMNS AND NOT A `collaborator_state` ENUM. The same
-- reasoning as the `ci_actions_*` intent columns added one migration earlier:
-- a stored state must be CLEARED by the same code path that sets it, so a
-- crash between the GitHub call and the write leaves it lying. Two timestamps
-- are DERIVED state — they cannot desynchronise, and a re-read recomputes the
-- same answer. The three states the UI renders
-- (`design/repository-set/design-notes.md` §5) fall straight out:
--
--   accepted     ⟺ collaborator_accepted_at IS NOT NULL
--   invited      ⟺ collaborator_invited_at IS NOT NULL AND NOT accepted
--   not_invited  ⟺ neither
--
-- It also means an enum never has to grow a `declined` value Motir cannot
-- observe: GitHub owns acceptance, and a declined invitation is simply one
-- that never becomes accepted.
--
-- WHY THE LOGIN IS STORED RATHER THAN RE-DERIVED. The account invited is the
-- one the ACTOR had connected at invite time (`github_identity.github_login` —
-- never a typed handle, which a typo would turn into an invitation to a
-- stranger). Re-deriving it at read time would show a LATER visitor their OWN
-- login for an invitation sent to someone else, which is precisely the
-- question this line answers on screen ("this is the account Motir invited").
--
-- WHY THE INVITATION URL IS STORED. The pending invitation is a GitHub object
-- with its own `html_url`; it cannot be reconstructed from `owner/name`, and
-- **Open the invitation** has nowhere to point without it.
--
-- NO RLS CHANGE. `project_repository_active_workspace` is already FOR ALL and
-- predicates purely on `workspace_id = current_setting('app.workspace_id')`;
-- these are four more columns on an already-guarded table and inherit that
-- policy unchanged. This table has NO `app.system_admin` escape and does not
-- grow one here — every access write runs under the acting member's workspace
-- context.
--
-- BACKFILL. All-NULL is the honest starting state for every existing row: no
-- invitation has been sent, which reads as `not_invited` — exactly the gap
-- this card exists to close, so the first pass over an already-created set
-- invites it rather than assuming it was handled.

ALTER TABLE "project_repository"
  ADD COLUMN "collaborator_login" TEXT,
  ADD COLUMN "collaborator_invited_at" TIMESTAMP(3),
  ADD COLUMN "collaborator_accepted_at" TIMESTAMP(3),
  ADD COLUMN "collaborator_invitation_url" TEXT;
