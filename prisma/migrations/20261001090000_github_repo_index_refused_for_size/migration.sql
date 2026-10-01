-- MOTIR-7129: a repository remembers that its last index was refused for size.
-- Additive and nullable: every existing github_repo row reads back with all three NULL.
ALTER TABLE "github_repo" ADD COLUMN "index_refused_size_bytes" BIGINT;
ALTER TABLE "github_repo" ADD COLUMN "index_refused_cap_bytes" BIGINT;
ALTER TABLE "github_repo" ADD COLUMN "index_refused_at" TIMESTAMP(3);
