# Load-test report — smoke at N = 1

**Verdict: FAIL** — throughput FAIL; reads p95 FAIL; reads p99 FAIL; writes, claims and runs p95 FAIL; writes, claims and runs p99 FAIL

## What answered

- **instances**: 1
- **sha**: f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0
- **shaReadFrom**: image_ref tag
- **neon**: {"project":"snowy-truth-13928044","branchId":"br-blue-sea-aup5noib","copiedAt":"2026-10-19T23:31:14Z","copiedAtField":"refresh.json","endpointHost":"ep-jolly-dawn-aumdpqm0.c-10.us-east-1.aws.neon.tech"}
- **app**: {"name":"motir-core-staging","size":"performance-1x-2048MB","machines":[{"id":"82ddd09f047508","region":"iad","cpus":1,"memoryMb":2048,"imageRef":"registry.fly.io/motir-core:f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0"}]}
- **production**: {"cpuKind":"performance","cpus":1,"memoryMb":2048}
- **candidateSize**: false
- **instancesHeld**: true
- **pinEnforced**: true
- **profile**: {"name":"smoke","path":"loadtest/profiles/smoke.json","loadHash":"371d0a8fa6eccb3dc60ebf8081372243127505764f287a1d1305779a20f61ab5"}
- **traceRate**: 0.1
- **concurrency**: {"type":"requests","softLimit":960,"hardLimit":1200}
- **requiredConcurrency**: {"hard":82,"soft":66}
- **rateLimits**: {"apiV1":6000,"mcp":"default","agentWorkspace":"default"}
- **offered**: {"rpsUpperBound":34.41,"perWorkspaceRps":16.91,"perTokenRps":{"mcp":2,"apiV1":0.45},"readerStreamsPerInstance":6}
- **generator**: {"machineId":"85777d7a271148","region":"iad","cpus":2,"cpuMean":0.012535416845539623,"cpuMax":0.015658837248042644}
- **k6**: {"version":"v1.2.1","extensions":["github.com/phymbert/xk6-sse v0.1.12"]}
- **window**: {"startedAt":"2026-10-20T19:20:22.000Z","rampEndedAt":"2026-10-20T19:21:22.000Z","steadyEndedAt":"2026-10-20T19:24:22.000Z","endedAt":"2026-10-20T19:25:34Z"}
- **prometheus**: {"endpoint":"https://api.fly.io/prometheus/moooon","app":"motir-core-staging","queriedAt":"2026-10-23T08:10:17.650Z","settleSeconds":60}
- **pgStatStatements**: {"before":{"host":"ep-jolly-dawn-aumdpqm0.c-10.us-east-1.aws.neon.tech","computeStartedAt":"2026-10-19T23:31:20.328Z","statsReset":"2026-10-19T23:31:20.325Z"},"after":{"host":"ep-jolly-dawn-aumdpqm0.c-10.us-east-1.aws.neon.tech","computeStartedAt":"2026-10-19T23:31:20.328Z","statsReset":"2026-10-19T23:31:20.325Z"}}
- **baseline**: none (N = 1)

> Staging's proxy limits are raised for the load test (1200 hard at the default profile) and are not production's (250), so a PASS says nothing about the production proxy limit — that is the sizing task's.

> Window times are the generator clock and Prometheus timestamps are Fly’s; skew is not measured, so every Prometheus range is widened by ±30 s.

### Comparable

```json
{
  "sha": "f8e7d68996e0c9de87ad09f4fdc5eb70728fafd0",
  "neonBranchId": "br-blue-sea-aup5noib",
  "neonCopiedAt": "2026-10-19T23:31:14Z",
  "app": "motir-core-staging",
  "machineIds": ["82ddd09f047508"],
  "size": "performance-1x-2048MB",
  "instances": 1,
  "profile": "smoke",
  "loadHash": "371d0a8fa6eccb3dc60ebf8081372243127505764f287a1d1305779a20f61ab5",
  "concurrency": {
    "type": "requests",
    "softLimit": 960,
    "hardLimit": 1200
  },
  "requiredConcurrency": {
    "hard": 82,
    "soft": 66
  },
  "rateLimits": {
    "apiV1": 6000,
    "mcp": "default",
    "agentWorkspace": "default"
  },
  "traceRate": 0.1,
  "generatorMachineId": "85777d7a271148",
  "generatorCpus": 2,
  "k6Version": "v1.2.1",
  "baseline": null
}
```

## Thresholds

| line                        | status | measured                                      | limit                | note                                                                                                                                                                                                                                  |
| --------------------------- | ------ | --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| throughput                  | FAIL   | 6 rps served                                  | ≥ 13 rps             | closed model: a miss can come from a slow server or from latency lengthening each VU cycle — read it beside the latency lines                                                                                                         |
| reads p95                   | FAIL   | 10359.23 ms                                   | ≤ 500 ms             |                                                                                                                                                                                                                                       |
| reads p99                   | FAIL   | 11885.08 ms                                   | ≤ 1500 ms            |                                                                                                                                                                                                                                       |
| writes, claims and runs p95 | FAIL   | 8656.21 ms                                    | ≤ 2000 ms            |                                                                                                                                                                                                                                       |
| writes, claims and runs p99 | FAIL   | 9220.24 ms                                    | ≤ 5000 ms            |                                                                                                                                                                                                                                       |
| error rate                  | PASS   | 0 % (0 of 1092)                               | < 0.1 %              |                                                                                                                                                                                                                                       |
| P2028                       | PASS   | 0                                             | ≤ 0                  | Blind spot: p2028\_\* counts only failures before the transaction body ran (lib/monitoring/transactionSpan.ts failedOutcome); a mid-body expiry is labelled rolled_back and shows as an error outcome in the latency lines, not here. |
| held streams lost           | PASS   | 0 (opened 22, open at end 22, reconnected 0)  | ≤ 0                  |                                                                                                                                                                                                                                       |
| rate-limit refusals         | PASS   | 0 % (0 refused of 1106; retry_after p95 none) | ≤ 1 %                |                                                                                                                                                                                                                                       |
| scale-out                   | n/a    | N = 1                                         | ≥ 0.8 × N × baseline |                                                                                                                                                                                                                                       |

Generator CPU over the steady window: mean 0.01, peak 0.02 — ok.

## P2028

P2028: 0 — PASS

- 82ddd09f047508: p2028_wait 0, p2028_timeout 0, committed rose 20497
- log cross-check: complete, 0 line(s)

> Blind spot: p2028\_\* counts only failures before the transaction body ran (lib/monitoring/transactionSpan.ts failedOutcome); a mid-body expiry is labelled rolled_back and shows as an error outcome in the latency lines, not here.

## Rate-limit refusals

PASS: 0 % (0 refused of 1106; retry_after p95 none) (limit ≤ 1 %)

## proxy_shed (a reading, not judged)

- platform 503s by instance: 82ddd09f047508 0
- proxy log codes: PL01 0, PL02 0, PR01 0
- client http_503: 0

> None of the three says who answered: Fly documents no header that marks a proxy-made response.

## First bottleneck

**app CPU**, saturated from 2026-10-20T19:21:07.000Z

- Fly proxy limit: not reached; peak 42 concurrent (hard limit 1200)
  - proxy_shed: platform 503 0, log codes 0, client http_503 0
- app CPU: from 2026-10-20T19:21:07.000Z; peak 1 of the machine's CPUs busy
  - steal peak 0.93 CPU-s/s
  - throttle peak 0 CPU-s/s (limit 0.05)
- app memory: not reached; peak available down to 31.86 % of total
- connection pool (wait/hold sink): from 2026-10-20T19:21:22.000Z; peak mean waiting 29.5, wait p95 0.81 s
  - the app pg.Pool (default max 10 per runtime) is the likelier first limit than the database
- database (Neon load): not reached; peak active 0.44 % of max_connections, 0 waiting on Lock
  - reads the DIRECT endpoint only, so it cannot see pooler saturation
  - readerStreamsPerInstance 6 (each held stream is one watermark read per second of background load)
  - endpoint at start: ep-jolly-dawn-aumdpqm0 active 0.25–2 CU; at end: ep-jolly-dawn-aumdpqm0 active 0.25–2 CU
  - compute at its autoscaling maximum: unmeasured (the endpoint record carries the range, not the current size)

> The database candidate reads the DIRECT endpoint only, so it cannot see pooler saturation; the app’s pg.Pool (default max 10 per runtime) is the likelier first limit.

> Every held stream costs one workbench watermark read per second: readerStreamsPerInstance 6 is background database load named here, not lost inside a req/s figure.

## Agent mix (steady window)

| class            | offered VUs | served rps | share   | ok  | empty | error | limited | p95 ms   | p99 ms   |
| ---------------- | ----------- | ---------- | ------- | --- | ----- | ----- | ------- | -------- | -------- |
| read             | 16          | 2.04       | 34.07 % | 368 | 0     | 0     | 0       | 10809.48 | 11978.79 |
| write            | 8           | 1.27       | 21.11 % | 228 | 0     | 0     | 0       | 8591.14  | 9246.95  |
| claim            | 5           | 0.71       | 11.85 % | 128 | 0     | 0     | 0       | 8784.9   | 9161.55  |
| burst            | 2           | 0.13       | 2.22 %  | 24  | 0     | 0     | 0       | 7362.81  | 7400.21  |
| run              | 3           | 0.49       | 8.15 %  | 88  | 0     | 0     | 0       | 7936.99  | 8645.07  |
| readers          | 8           | 1.36       | 22.59 % | 244 | 0     | 0     | 0       | 9063.06  | 11080.31 |
| readers · tab    | 6           | 1.19       | 19.81 % | 214 | 0     | 0     | 0       | 3619.59  | 3974.66  |
| readers · browse | 2           | 0.17       | 2.78 %  | 30  | 0     | 0     | 0       | 11417.83 | 12281.35 |
| total            | 42          | 6          |         |     |       |       |         |          |          |

> Served is ok + empty over the steady window, as the throughput line counts it; the held workbench stream and the run recycle step are in no class, so the top-level rows sum to the served rps. readers · tab and readers · browse split the readers row by k6’s scenario tag.

## Per route (steady window)

| route                   | rps  | p95 ms     | p99 ms     |
| ----------------------- | ---- | ---------- | ---------- |
| run recycle             | 0.07 | 13357.58   | 13357.58   |
| reader plan_poll        | 0.06 | 12281.35   | 12281.35   |
| mcp get_plan            | 0.37 | 11978.79   | 12202.98   |
| mcp get_work_item       | 0.85 | 9828.58    | 10391.23   |
| reader plan_get         | 0.05 | 9800.23    | 9800.23    |
| mcp transition_status   | 0.46 | 9220.24    | 9961.68    |
| mcp claim_work_item     | 0.23 | 8933.46    | 9161.55    |
| run claim               | 0.03 | 8645.07    | 8645.07    |
| mcp move_to_parent      | 0.13 | 7362.81    | 7400.21    |
| run read                | 0.19 | 7132.62    | 7883.04    |
| mcp add_comment         | 0.4  | 6898.32    | 7154.56    |
| mcp update_work_item    | 0.74 | 5409.34    | 5821.38    |
| mcp add_plan_items      | 0.14 | 5394.16    | 5515.41    |
| mcp search_work_items   | 0.58 | 5237.62    | 5374.87    |
| mcp skeleton            | 0.24 | 4957.36    | 5311.31    |
| run prompt              | 0.03 | 4912.22    | 4912.22    |
| reader workbench_window | 1.02 | 3669.17    | 4006.21    |
| run open                | 0.04 | 3274.33    | 3274.33    |
| reader items            | 0.03 | 3158.72    | 3158.72    |
| reader workbench        | 0.17 | 2468.74    | 2507.14    |
| run close               | 0.04 | 2235.33    | 2235.33    |
| run events              | 0.12 | 1794.88    | 2242.91    |
| reader boards           | 0.02 | 1778.19    | 1778.19    |
| run heartbeat           | 0.04 | 1721.2     | 1721.2     |
| reader workbench_stream | 0.08 | unmeasured | unmeasured |

## Wait and hold (seconds)

| by    | name              | wait p95 | wait p99 | hold p95 | hold p99 |
| ----- | ----------------- | -------- | -------- | -------- | -------- |
| route | mcp               | 0.71     | 1.04     | 0.22     | 0.85     |
| route | plan_get          | 0.75     | 1        | 0.21     | 0.25     |
| route | unlabelled        | 0.63     | 0.99     | 0.41     | 0.85     |
| route | workbench         | 0.17     | 0.24     | 0.5      | 1.05     |
| route | workbench_stream  | 0.78     | 1.13     | 0.49     | 0.99     |
| tool  | unknown           | 0.74     | 1.16     | 0.17     | 0.33     |
| tool  | add_comment       | 0.76     | 1.35     | 0.22     | 0.4      |
| tool  | add_plan_items    | 0.76     | 0.97     | 0.2      | 0.56     |
| tool  | claim_work_item   | 0.64     | 1.06     | 0.87     | 1.81     |
| tool  | get_plan          | 0.71     | 0.99     | 0.2      | 0.26     |
| tool  | get_work_item     | 0.67     | 0.99     | 0.22     | 0.48     |
| tool  | move_to_parent    | 0.89     | 1.68     | 0.37     | 0.76     |
| tool  | search_work_items | 0.68     | 0.97     | 0.19     | 0.25     |
| tool  | skeleton          | 0.72     | 1.55     | 0.22     | 0.48     |
| tool  | transition_status | 0.68     | 1        | 0.61     | 1.66     |
| tool  | update_work_item  | 0.76     | 1.15     | 0.23     | 0.42     |

## Top statements by total-time delta

| Δ total ms | Δ calls | statement                                                                                                                                                                                                  |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3305.76    | 1076    | `SELECT "id" FROM "work_item" WHERE "id" = $1 FOR UPDATE`                                                                                                                                                  |
| 906.61     | 2040    | `INSERT INTO "public"."job_step" ("id","run_id","step_id","kind","result","workspace_id","created_at") VALUES ($1,$2,$3,CAST($4::text AS "public"."job_step_kind"),$5,$6,$7) RETURNING "public"."job_step` |
| 531.57     | 4331    | `SELECT o."closing_since" AS "closingSince" FROM "workspace" w JOIN "organization" o ON o."id" = w."organizationId" WHERE w."id" = $1 LIMIT $2`                                                            |
| 413.21     | 1930    | `INSERT INTO "public"."job_queue" ("id","job_id","event_id","event_name","workspace_id","run_at","attempts","max_attempts","state","idempotency_key","created_at","updated_at") VALUES ($1,$2,$3,$4,$5,$6` |
| 326.21     | 7299    | `SELECT "public"."project"."id", "public"."project"."workspaceId", "public"."project"."name", "public"."project"."slug", "public"."project"."identifier", "public"."project"."lastWorkItemNumber", "publi` |
| 240.33     | 639     | `INSERT INTO "public"."job_run" ("id","workspace_id","function_id","event_name","event_id","lane","attempt","status","started_at","idempotency_key") VALUES ($1,$2,$3,$4,$5,CAST($6::text AS "public"."jo` |
| 213.51     | 34165   | `SELECT set_config($2, $1, $3)`                                                                                                                                                                            |
| 191.12     | 433     | `INSERT INTO "public"."work_item_revision" ("id","workItemId","changedById","changedAt","changeKind","diff") VALUES ($1,$2,$3,$4,$5,$6) RETURNING "public"."work_item_revision"."id", "public"."work_item` |
| 184.12     | 7713    | `SELECT "public"."workspace_membership"."id", "public"."workspace_membership"."userId", "public"."workspace_membership"."workspaceId", "public"."workspace_membership"."activeProjectId", "public"."works` |
| 159.99     | 7       | `UPDATE "public"."job_queue" SET "state" = CAST($1::text AS "public"."job_run_state"), "run_at" = $2, "claimed_by" = $3, "lease_expires_at" = $4, "last_error" = $5, "updated_at" = $6 WHERE ("public"."j` |

entered the top 200: 45; left it: 33

## Cross-checks

- mcp_rate_limited (summary.json, a Rate: passes = the sum of its values) 0 vs mcp_calls outcome limited over the run 0
- run_limited (summary.json) unmeasured vs run_steps outcome limited over the run 0
- 870 judged samples fell outside the steady window and were not judged
