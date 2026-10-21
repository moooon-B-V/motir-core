-- LIVE-SIGNAL TRIGGERS (Story MOTIR-8542 · Subtask MOTIR-8727)
--
-- Every committed write to a table the Workbench watermark or the plan review
-- version reads from emits ONE Postgres notification on `live_signal`, whoever
-- the writer is: a service, a job, an MCP tool, raw SQL, a migration. The
-- per-process hub (`lib/live/liveSignalHub.ts`) LISTENs on it and wakes the open
-- streams, which re-read under the reader's own context.
--
-- WHY TRIGGERS, NOT AN APP-LEVEL EMITTER. An emitter must be remembered at every
-- write site, and a forgotten one is silent: the tab is never nudged while the
-- list stays correct on reload. A trigger fires for every writer, and
-- `tests/integration/live/liveSignalTriggers.test.ts` enumerates the tables, so
-- "a forgotten site" becomes a failing test.
--
-- THE PAYLOAD — the contract `lib/live/liveNotification.ts` owns — is IDS ONLY:
--   {"w": <workspace id>, "p": <project id | null>, "plan": <plan id | null>}
-- No title, status, count, user id or timestamp. A notification is a HINT; the
-- reader's own read stays the authority and the access decision.
--
-- DELIVERY SEMANTICS, both wanted: Postgres delivers on COMMIT only and drops on
-- rollback, and collapses identical payloads within one transaction — so 189 row
-- updates to one project in one transaction produce one notification.
--
-- PER-ROW COST:
--   * `work_item`, `approval_gate`, `plan_change_session`, `plan`: none beyond
--     building the payload — they carry their own workspace and project.
--     (`plan_change_session` also reads the plans of the session, through the
--     `plan_session_id_idx` index: its `turn_count` is part of the review
--     fingerprint of every plan whose `session_id` names it.)
--   * `watcher`: one primary-key lookup on `work_item`.
--   * `plan_item`, `plan_revision`, `plan_step`, `plan_narration`,
--     `plan_narration_session`: one primary-key lookup on `plan`.
--
-- ⚠️ A TRIGGER THAT RAISES ROLLS BACK THE USER'S WRITE. So no lookup raises: a
-- missing parent (a cascade delete in flight) reads NULL ids, and a row whose
-- workspace cannot be resolved emits nothing — the parent's own trigger has
-- already signalled that workspace.
--
-- SECURITY DEFINER with `search_path` pinned, for the reason
-- 20260817160000_work_item_parent_tenancy records: under RLS an INVOKER lookup of
-- a parent outside the writer's bound project reads NULL. The functions read ids
-- by primary key and output nothing but the notification.
--
-- Deliberately NOT triggered: the tables the reads touch only to decide ACCESS
-- (membership, project, workspace). A change in who may see what is not a write
-- to a watermark input; each stream's 60 s backstop heals it.
-- `lib/live/liveSignalTables.ts` records both lists.

CREATE OR REPLACE FUNCTION live_signal_emit(w text, p text, plan text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF w IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_notify('live_signal', json_build_object('w', w, 'p', p, 'plan', plan)::text);
END;
$$;

CREATE OR REPLACE FUNCTION live_signal_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w text;
  p text;
  pl text;
  plan_id_of_row text;
  session_id_of_row text;
  linked record;
  found_plan boolean;
BEGIN
  IF TG_TABLE_NAME = 'work_item' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM live_signal_emit(OLD."workspaceId", OLD."projectId", NULL);
    ELSE
      PERFORM live_signal_emit(NEW."workspaceId", NEW."projectId", NULL);
      -- A move between projects is heard by the project it LEFT as well.
      IF TG_OP = 'UPDATE' AND (OLD."projectId" IS DISTINCT FROM NEW."projectId"
          OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId") THEN
        PERFORM live_signal_emit(OLD."workspaceId", OLD."projectId", NULL);
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'watcher' THEN
    SELECT wi."workspaceId", wi."projectId" INTO w, p
      FROM "work_item" wi
     WHERE wi."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."work_item_id" ELSE NEW."work_item_id" END);
    PERFORM live_signal_emit(w, p, NULL);

  ELSIF TG_TABLE_NAME = 'approval_gate' THEN
    IF TG_OP = 'DELETE' THEN
      pl := CASE WHEN OLD."kind"::text = 'plan_approval' THEN OLD."subject_id" END;
      PERFORM live_signal_emit(OLD."workspace_id", OLD."project_id", pl);
    ELSE
      pl := CASE WHEN NEW."kind"::text = 'plan_approval' THEN NEW."subject_id" END;
      PERFORM live_signal_emit(NEW."workspace_id", NEW."project_id", pl);
    END IF;

  ELSIF TG_TABLE_NAME = 'plan_change_session' THEN
    IF TG_OP = 'DELETE' THEN
      w := OLD."workspace_id";
      p := OLD."project_id";
      session_id_of_row := OLD."id";
    ELSE
      w := NEW."workspace_id";
      p := NEW."project_id";
      session_id_of_row := NEW."id";
    END IF;
    found_plan := false;
    FOR linked IN SELECT pn."id" FROM "plan" pn WHERE pn."session_id" = session_id_of_row LOOP
      found_plan := true;
      PERFORM live_signal_emit(w, p, linked."id");
    END LOOP;
    IF NOT found_plan THEN
      PERFORM live_signal_emit(w, p, NULL);
    END IF;

  ELSIF TG_TABLE_NAME = 'plan' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM live_signal_emit(OLD."workspace_id", OLD."project_id", OLD."id");
    ELSE
      PERFORM live_signal_emit(NEW."workspace_id", NEW."project_id", NEW."id");
    END IF;

  ELSE
    -- The plan-child tables: plan_item, plan_revision, plan_step,
    -- plan_narration, plan_narration_session. Each carries `plan_id` only.
    IF TG_OP = 'DELETE' THEN
      plan_id_of_row := OLD."plan_id";
    ELSE
      plan_id_of_row := NEW."plan_id";
    END IF;
    SELECT pn."workspace_id", pn."project_id" INTO w, p
      FROM "plan" pn
     WHERE pn."id" = plan_id_of_row;
    PERFORM live_signal_emit(w, p, plan_id_of_row);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_live_signal_work_item"
  AFTER INSERT OR UPDATE OR DELETE ON "work_item"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_watcher"
  AFTER INSERT OR UPDATE OR DELETE ON "watcher"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_approval_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "approval_gate"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan_change_session"
  AFTER INSERT OR UPDATE OR DELETE ON "plan_change_session"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan"
  AFTER INSERT OR UPDATE OR DELETE ON "plan"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan_item"
  AFTER INSERT OR UPDATE OR DELETE ON "plan_item"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan_revision"
  AFTER INSERT OR UPDATE OR DELETE ON "plan_revision"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan_step"
  AFTER INSERT OR UPDATE OR DELETE ON "plan_step"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan_narration"
  AFTER INSERT OR UPDATE OR DELETE ON "plan_narration"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_plan_narration_session"
  AFTER INSERT OR UPDATE OR DELETE ON "plan_narration_session"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();
