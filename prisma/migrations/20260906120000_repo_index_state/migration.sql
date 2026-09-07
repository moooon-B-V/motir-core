-- THE PER-REPO INDEX STATE (Story MOTIR-4669 · MOTIR-4724).
--
-- `Settings → Organisation → Git` draws FOUR index states per repository and
-- motir-core could compute TWO. Both missing arms were blocked by properties the
-- owning code documents about ITSELF, which is why neither was visible from a card:
--
--   * STALE needs the indexed commit compared against the default-branch head.
--     `jobRunRepository.listSucceededCodeGraphIndexRepoRefs`: "Staleness (graph
--     commit vs the default-branch head) is MOTIR-1754/1766's axis and
--     deliberately not read here." Neither column existed.
--   * INDEXING is not attributable. `findRunningCodeGraphIndexForWorkspace`: "a
--     `running` row has no `output.repoRef` … so the ledger cannot say WHICH repo
--     a running row belongs to — only that one is in flight."
--
-- Four nullable columns, no backfill, no default. A repository that predates this
-- migration reads exactly as it did: `indexed` or `never`, from the ledger. The
-- two new arms light up as the data arrives — a push for the head, an index run
-- for the rest — which is what makes this deployable without a sweep.
--
-- ⚠️ NULL IS "NOT KNOWN YET", NEVER "UP TO DATE". The derivation
-- (`lib/codeGraph/indexState.ts`) refuses to report `stale` from a missing
-- comparand: an absent head sha means nobody has pushed since the deploy, not
-- that the graph is behind.

-- AlterTable
ALTER TABLE "github_repo" ADD COLUMN     "default_branch_head_sha" TEXT,
ADD COLUMN     "indexed_at" TIMESTAMP(3),
ADD COLUMN     "indexed_head_sha" TEXT,
ADD COLUMN     "indexing_run_id" TEXT;

