---
kind: task
type: deploy
---

Roll the new search service out to production.

## Steps

Deploy to the canary region, watch the error rate for an hour, then deploy to the rest.

## Post-deploy verification

Run the three smoke queries and compare the result counts with the previous release.

## Rollback

Redeploy the previous image tag; the index format is unchanged so no data step is needed.

## Scope BOUNDARY

The deploy only. Index tuning follows separately.

## Acceptance criteria

- Production serves the new release.
- The smoke queries match the previous counts.

## Context refs

- `deploy/search.toml` — the service definition
- `docs/runbooks/search.md` — the runbook
